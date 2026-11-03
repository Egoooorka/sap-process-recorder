import base64, json, os, sys, tempfile, threading, time, unittest, urllib.request, urllib.error, wave
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["ASR_DATA_DIR"] = tempfile.mkdtemp()

from asr_helper import hardware
from asr_helper.backends import REGISTRY, register
from asr_helper.backends.base import ASRBackend, Cancelled
from asr_helper.backends.mlx_whisper import parse_segment_end
from asr_helper.jobs import JobManager, choose_backend
from asr_helper.server import make_handler, load_token, health


class FakeBackend(ASRBackend):
    id, label = "fake", "Fake"
    last_req = None
    def models(self): return {"large-v3-turbo": {"label": "x", "ref": "r"}, "large-v3": {"label": "y", "ref": "r2"}}
    def available(self): return True, ""
    def model_installed(self, m): return True
    def transcribe(self, req, report, cancelled):
        FakeBackend.last_req = req
        for i in range(4):
            if cancelled(): raise Cancelled()
            report((i + 1) / 4, "transcribing", "t"); time.sleep(0.05)
        return {"language": "ru", "model_ref": "r",
                "segments": [{"start": 0.0, "end": 1.5, "text": " Привет, это Purchase Order "}, {"start": 2.0, "end": 3.0, "text": "второй сегмент"}]}


def fake_convert(src, dst):
    with wave.open(dst, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000 * 3)
    return 3.0


class HardwareTests(unittest.TestCase):
    def test_preference(self):
        self.assertEqual(hardware.backend_preference({"apple_silicon": True, "rosetta": False, "machine": "arm64"}), ["mlx-whisper", "whisper.cpp"])
        self.assertEqual(hardware.backend_preference({"apple_silicon": True, "rosetta": True, "machine": "x86_64"}), ["whisper.cpp"])
        self.assertEqual(hardware.backend_preference({"apple_silicon": False, "rosetta": False, "machine": "x86_64"}), ["whisper.cpp"])

    def test_detect_runs(self):
        hw = hardware.detect_hardware()
        self.assertIn("native_arch", hw)

    def test_parse_progress(self):
        self.assertEqual(parse_segment_end("[00:03.120 --> 00:07.480]  hi"), 7.48)
        self.assertEqual(parse_segment_end("[01:00:03.000 --> 01:00:10.500] x"), 3610.5)
        self.assertIsNone(parse_segment_end("Detected language: Russian"))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        register(FakeBackend())
        hw = {"apple_silicon": True, "rosetta": False, "machine": "arm64", "native_arch": "arm64", "cpus": 4, "chip": "test"}
        cls.mgr = JobManager(converter=fake_convert, hw=hw)
        cls.token = load_token()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: None)
        cls.httpd.server_close()
        port = 0
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.mgr, cls.token, 0))
        cls.port = cls.httpd.server_address[1]
        cls.httpd.RequestHandlerClass = make_handler(cls.mgr, cls.token, cls.port)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, method, path, data=None, token=True, headers=None):
        h = {"X-ASR-Token": self.token} if token else {}
        h.update(headers or {})
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def wait(self, jid):
        for _ in range(100):
            code, j = self.req("GET", f"/jobs/{jid}")
            if j["status"] in ("done", "error", "cancelled"): return j
            time.sleep(0.1)
        self.fail("timeout")

    def test_auth(self):
        self.assertEqual(self.req("GET", "/health", token=False)[0], 401)
        self.assertEqual(self.req("GET", "/health", headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.req("GET", "/health", headers={"Origin": "chrome-extension://abc"})[0], 200)

    def test_health_and_choice(self):
        code, h = self.req("GET", "/health")
        self.assertEqual(code, 200)
        self.assertIn("fake", [b["id"] for b in h["backends"]])
        self.assertEqual(h["default_model"], "large-v3-turbo")

    def test_job_roundtrip_and_task_is_transcribe(self):
        prompt = base64.b64encode("Purchase Order, Fiori".encode()).decode()
        code, r = self.req("POST", "/jobs?backend=fake&language=ru&model=large-v3-turbo&task=translate", b"webmbytes",
                           headers={"X-ASR-Prompt-B64": prompt})
        self.assertEqual(code, 202)
        j = self.wait(r["id"])
        self.assertEqual(j["status"], "done", j)
        res = j["result"]
        self.assertEqual(res["task"], "transcribe")           # a client-supplied task=translate is ignored
        self.assertEqual(FakeBackend.last_req.task, "transcribe")
        self.assertEqual(FakeBackend.last_req.language, "ru")
        self.assertEqual(FakeBackend.last_req.prompt, "Purchase Order, Fiori")
        self.assertEqual(res["segments"][0]["text"], "Привет, это Purchase Order")
        self.assertEqual(res["duration"], 3.0)
        self.assertEqual(res["segments"][1]["id"], 1)
        # temp audio removed
        self.assertFalse(os.path.exists(os.path.join(self.mgr.jobs[r["id"]].dir, "audio.wav")))

    def test_auto_language_and_unknown_model_error(self):
        code, r = self.req("POST", "/jobs?backend=fake&language=auto&model=nope", b"x")
        j = self.wait(r["id"])
        self.assertEqual(j["status"], "error")
        self.assertIn("not supported", j["error"])

    def test_cancel(self):
        code, r = self.req("POST", "/jobs?backend=fake&language=ru", b"x")
        self.req("DELETE", f"/jobs/{r['id']}")
        j = self.wait(r["id"])
        self.assertIn(j["status"], ("cancelled", "done"))

    def test_choose_backend_unavailable(self):
        with self.assertRaises(Exception):
            choose_backend("mlx-whisper" if "mlx-whisper" in REGISTRY else "nope", {})


if __name__ == "__main__":
    unittest.main()
