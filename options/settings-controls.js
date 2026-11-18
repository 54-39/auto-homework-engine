/* 设置页复用面板下拉；保留原 select 的配置读写与 change 事件。
   enhance 可重复调用：模型选项随接口地址变化，重建时沿用同一个占位容器。 */
import '../content/homework/dropdown.js';

function enhance(select) {
  select._dd?.close();
  let slot = select._ddSlot;
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'dd settings-select';
    select.after(slot);
    select.hidden = true;
    select._ddSlot = slot;
  }
  slot.replaceChildren();
  select._dd = HW.Dropdown.create({
    into: slot,
    items: [...select.options].map(option => ({ id: option.value, label: option.textContent })),
    value: select.value,
    onChange: value => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
  const trigger = slot.querySelector('button');
  trigger.id = select.id + '-trigger';
  const label = document.querySelector(`label[for="${select.id}"]`);
  if (label) label.htmlFor = trigger.id;
  const syncDisabled = () => {
    const trig = slot.querySelector('button');
    if (!trig) return;
    const disabled = select.matches(':disabled');
    if (trig.disabled !== disabled) trig.disabled = disabled;
    if (disabled) select._dd.close();
  };
  select._ddSync = syncDisabled;
  if (!select._ddWrapped) {
    select._ddWrapped = true;
    const value = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      get() { return value.get.call(this); },
      set(next) { value.set.call(this, next); select._dd.value = value.get.call(this); },
    });
    new MutationObserver(() => select._ddSync()).observe(select.closest('form') || select.parentElement, {
      attributes: true, subtree: true, attributeFilter: ['disabled'],
    });
  }
  syncDisabled();
  return select._dd;
}

HW.SettingsControls = { enhance };
for (const select of document.querySelectorAll('select')) enhance(select);

/* 问号说明：点击在设置项上方展开为行内文本块，再点同一个收起；同时只展开一条。
   不用悬浮气泡：长说明要能停留细读，行内块随页面滚动、排版与正文一致。 */
let openHelp = null;
const note = document.createElement('p');
note.className = 'hw-note';
const closeNote = () => { note.remove(); openHelp?.setAttribute('aria-expanded', 'false'); openHelp = null; };
document.addEventListener('click', e => {
  const el = e.target.closest('.help');
  if (!el) return;
  e.preventDefault(); // 问号在 label/summary 里时，不能连带勾选复选框或折叠详情
  if (openHelp === el) return closeNote();
  closeNote();
  openHelp = el;
  el.setAttribute('aria-expanded', 'true');
  note.textContent = el.dataset.tip;
  const anchor = el.closest('.app-field,.check-row,.field,details') || el.parentElement;
  /* 字段内插在标签行后、控件前：问号绝对定位在字段右上角，展开说明不会移动问号 */
  if (anchor.classList.contains('app-field')) anchor.firstElementChild.after(note);
  else anchor.after(note);
});