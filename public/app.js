const $ = selector => document.querySelector(selector);
const toast = message => { $('#toast').textContent = message; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 3200); };
async function post(url, data) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请重试');
  return result;
}
document.querySelectorAll('[data-pack]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try { const result = await post('/api/orders', { packId: button.dataset.pack }); location.href = result.payUrl; }
  catch (error) { toast(error.message); button.disabled = false; }
}));
$('#topic')?.addEventListener('input', event => { $('#count').textContent = `${event.target.value.length} / 500`; });
$('#generate-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true; button.textContent = '✧ 正在酝酿灵感…'; $('#generate-error').textContent = '';
  try {
    const result = await post('/api/generate', Object.fromEntries(new FormData(event.target)));
    $('#output-empty').hidden = true; $('#output').hidden = false; $('#output').textContent = result.text;
    $('#source').textContent = `${result.source} · 已消耗 1 次`; $('#copy').disabled = false;
    document.querySelectorAll('[data-credits]').forEach(el => { el.textContent = result.credits; });
    toast('灵感成稿，创作完成！');
  } catch (error) { $('#generate-error').textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = '✧ 生成我的灵感文案 <span>→</span>'; }
});
$('#copy')?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#output').textContent); toast('文案已复制'); } catch { toast('复制不可用，请手动选择文案复制'); }
});
