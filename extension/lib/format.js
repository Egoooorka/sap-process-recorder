const q = (s) => `"${s}"`;

export function fmtClock(ms) {
  if (ms == null) return '–';
  const neg = ms < 0;
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(1).padStart(4, '0');
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${s}`;
}

export function describeEvent(e) {
  const where = e.dialog ? ` in dialog ${q(e.dialog)}` : '';
  const label = e.label || e.ui5Id || e.id || e.tag || 'element';
  switch (e.type) {
    case 'initial_screen': return `Recording started on ${q(e.title || e.url || '')}`;
    case 'click': return `Clicked ${e.role || e.tag || 'element'} ${q(label)}${where}`;
    case 'input':
      return e.value != null
        ? `Entered ${q(e.value)} in field ${q(label)}${where}`
        : `Entered a value in field ${q(label)}${e.masked ? ' (masked)' : ''}${where}`;
    case 'select':
      return e.value != null ? `Selected ${q(e.value)} in ${q(label)}${where}` : `Changed selection in ${q(label)}${where}`;
    case 'toggle': return `${e.checked ? 'Checked' : 'Unchecked'} ${q(label)}${where}`;
    case 'navigation': return `Navigated (${e.navKind}) to ${e.title ? q(e.title) + ' – ' : ''}${e.url}`;
    case 'dialog_open': return `Dialog opened: ${q(e.title || '')}${e.text ? ` – ${e.text}` : ''}`;
    case 'dialog_close': return `Dialog closed: ${q(e.title || '')}`;
    case 'toast': return `Message shown: ${q(e.text || '')}`;
    case 'manual_screenshot': return 'Manual screenshot';
    case 'tab_hidden': return 'User switched to another tab (not recorded)';
    case 'tab_visible': return 'User returned to the recorded tab';
    case 'session_stop': return `Recording stopped (${e.reason || 'user'})`;
    default: return e.type;
  }
}
