/* 设置页复用面板下拉；保留原 select 的配置读写与 change 事件。 */
import '../content/homework/dropdown.js';

for (const select of document.querySelectorAll('select')) {
  const slot = document.createElement('div');
  slot.className = 'dd settings-select';
  select.after(slot);
  select.hidden = true;
  const control = HW.Dropdown.create({
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
  const value = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    get() { return value.get.call(this); },
    set(next) { value.set.call(this, next); control.value = value.get.call(this); },
  });
  const syncDisabled = () => {
    const disabled = select.matches(':disabled');
    if (trigger.disabled !== disabled) trigger.disabled = disabled;
    if (trigger.disabled) control.close();
  };
  new MutationObserver(syncDisabled).observe(select.closest('form') || select.parentElement, {
    attributes: true, subtree: true, attributeFilter: ['disabled'],
  });
  syncDisabled();
}
