const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 19090;
const CONFIG_FILE = path.join(__dirname, 'config.json');

const defaults = {
  listenPath: '/v1/responses',
  targetUrl: 'https://api.deepseek.com/chat/completions',
  filterParams: ['tools', 'tool_choice'],
  enableInputTransform: true,
  modelOverride: ''
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = { ...defaults, ...loadConfig() };

const MAX_LOGS = 500;
const logBuffer = [];

function addLog(level, msg) {
  const entry = { time: new Date().toISOString(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  console.log(`[${level}]`, msg);
}

function injectToolsIntoMessages(body, tools, toolChoice) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return;

  const parts = [];
  for (const t of tools) {
    if (t.type === 'function' && t.function) {
      let desc = `- ${t.function.name}`;
      if (t.function.description) desc += `: ${t.function.description}`;
      if (t.function.parameters) desc += `\n  parameters: ${JSON.stringify(t.function.parameters)}`;
      parts.push(desc);
    }
  }

  if (parts.length === 0) return;

  let toolMsg = 'Available functions:\n' + parts.join('\n');
  if (toolChoice) {
    toolMsg += `\n\nTool choice mode: ${toolChoice}`;
  }
  toolMsg += '\n\nWhen you need to use a function, respond with the function name and arguments in JSON format.';

  if (!body.messages) body.messages = [];

  const systemIdx = body.messages.findIndex(m => m.role === 'system');
  if (systemIdx >= 0) {
    body.messages[systemIdx].content = body.messages[systemIdx].content + '\n\n' + toolMsg;
  } else {
    body.messages.unshift({ role: 'system', content: toolMsg });
  }
}

function transformInput(body) {
  if (!body.input || !Array.isArray(body.input)) return;

  const contentToMessage = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text || '');
      } else if (part.type === 'input_image') {
        parts.push({ type: 'image_url', image_url: { url: part.image_url } });
      }
      // unsupported types are silently dropped
    }

    if (parts.length === 0) return '';
    if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
    return parts;
  };

  const messages = [];
  for (const item of body.input) {
    const msg = { role: item.role };
    const content = contentToMessage(item.content);
    if (content === '') continue; // skip empty content
    msg.content = content;
    messages.push(msg);
  }

  if (body.instructions) {
    messages.unshift({ role: 'system', content: body.instructions });
    delete body.instructions;
  }

  if (messages.length > 0) {
    body.messages = messages;
  }
  delete body.input;
}

function makeId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function finishReasonToStatus(reason) {
  const map = { 'stop': 'completed', 'length': 'completed', 'content_filter': 'completed' };
  return map[reason] || 'completed';
}

function transformOutput(body) {
  const parsed = JSON.parse(body);
  if (!parsed.choices) return body;

  const responseId = parsed.id || makeId('resp');
  const output = [];

  for (const choice of parsed.choices) {
    const msg = choice.message || {};
    const item = {
      type: 'message',
      id: makeId('msg'),
      role: msg.role || 'assistant',
      status: 'completed',
      content: []
    };

    if (msg.content) {
      item.content.push({ type: 'output_text', text: msg.content });
    }

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input = {};
        if (tc.function && tc.function.arguments) {
          try { input = JSON.parse(tc.function.arguments); } catch (e) { /* raw string */ }
        }
        item.content.push({
          type: 'tool_use',
          id: tc.id || makeId('tool'),
          name: tc.function ? tc.function.name : '',
          input: input
        });
      }
    }

    output.push(item);
  }

  return JSON.stringify({
    id: responseId,
    object: 'response',
    status: finishReasonToStatus(parsed.choices[0]?.finish_reason),
    model: parsed.model,
    output: output,
    usage: parsed.usage
  });
}

function createSSETransformer() {
  let buffer = '';
  let responseId = null;
  let createdSent = false;
  let completedSent = false;
  let itemId = null;
  let outputIndex = 0;
  let contentIndex = 0;
  let model = '';
  let textContent = '';

  function sseEvent(event, data) {
    return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  }

  function emitCompleted() {
    completedSent = true;
    const content = [{ type: 'output_text', text: textContent }];
    let out = '';
    out += sseEvent('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: itemId, output_index: outputIndex, content_index: Math.max(0, contentIndex - 1),
      part: { type: 'output_text', text: textContent }
    });
    out += sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      item: { id: itemId, object: 'realtime.item', type: 'message', role: 'assistant', status: 'completed', content }
    });
    out += sseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: responseId, object: 'response', status: 'completed', model: model,
        output: [{ type: 'message', id: itemId, role: 'assistant', status: 'completed', content }]
      }
    });
    return out;
  }

  return function transform(chunk) {
    if (chunk === null) {
      // flush: end of stream
      if (createdSent && !completedSent) return emitCompleted();
      return '';
    }

    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    let output = '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') {
        if (createdSent && !completedSent) output += emitCompleted();
        continue;
      }

      try {
        const chunk = JSON.parse(payload);
        if (!chunk.choices || !chunk.choices[0]) continue;

        const choice = chunk.choices[0];
        const delta = choice.delta || {};

        if (!responseId) {
          responseId = makeId('resp');
          itemId = makeId('msg');
          model = chunk.model || '';
        }

        const content = delta.content || '';

        if (!createdSent && (content || delta.role)) {
          createdSent = true;
          output += sseEvent('response.created', {
            type: 'response.created',
            response: { id: responseId, object: 'response', status: 'in_progress', model: model, output: [] }
          });
          output += sseEvent('response.in_progress', {
            type: 'response.in_progress', response_id: responseId
          });
          output += sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: { id: itemId, object: 'realtime.item', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
          });
          output += sseEvent('response.content_part.added', {
            type: 'response.content_part.added',
            item_id: itemId, output_index: outputIndex, content_index: contentIndex,
            part: { type: 'output_text', text: '' }
          });
        }

        if (content) {
          textContent += content;
          output += sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            delta: content, item_id: itemId, output_index: outputIndex, content_index: contentIndex
          });
          contentIndex++;
        }

        if (choice.finish_reason && choice.finish_reason !== 'tool_calls') {
          if (!completedSent) output += emitCompleted();
        }
      } catch (e) { /* skip */ }
    }

    return output;
  };
}

function handleProxy(req, res) {
  let body = '';
  req.on('data', c => { body += c.toString(); });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const filtered = { ...parsed };

      // capture filtered params before deletion so we can inject them into messages
      const capturedTools = config.filterParams.includes('tools') ? parsed.tools : null;
      const capturedToolChoice = config.filterParams.includes('tool_choice') ? parsed.tool_choice : null;

      for (const p of config.filterParams) {
        delete filtered[p];
      }

      if (config.enableInputTransform) {
        transformInput(filtered);
        injectToolsIntoMessages(filtered, capturedTools, capturedToolChoice);
      }

      if (config.modelOverride) {
        addLog('info', `model override: "${parsed.model}" → "${config.modelOverride}"`);
        filtered.model = config.modelOverride;
      }

      addLog('info', `original keys: [${Object.keys(parsed).join(', ')}] → filtered: [${Object.keys(filtered).join(', ')}]`);
      addLog('info', `forwarding to ${config.targetUrl}`);
      addLog('debug', `original:\n${JSON.stringify(parsed, null, 2)}\nforwarded:\n${JSON.stringify(filtered, null, 2)}`);

      const target = new URL(config.targetUrl);
      const transport = target.protocol === 'https:' ? https : http;

      const proxyReq = transport.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers['authorization'] || '',
          'Accept': 'application/json, text/event-stream'
        }
      }, proxyRes => {
        const isStream = proxyRes.headers['content-type'] &&
          proxyRes.headers['content-type'].includes('text/event-stream');

        if (isStream) {
          addLog('info', `streaming response started (${proxyRes.statusCode})`);
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
          });
          res.flushHeaders();

          req.on('close', () => {
            if (!res.writableEnded) {
              addLog('info', 'client disconnected, aborting upstream');
              proxyReq.destroy();
            }
          });
          res.on('close', () => {
            proxyReq.destroy();
          });

          const transformStream = createSSETransformer();
          let streamEnded = false;
          proxyRes.on('data', chunk => {
            if (!res.writableEnded) {
              const transformed = transformStream(chunk);
              if (transformed) res.write(transformed);
            } else if (!streamEnded) {
              streamEnded = true;
              proxyReq.destroy();
            }
          });
          proxyRes.on('end', () => {
            streamEnded = true;
            addLog('info', 'streaming response ended');
            if (!res.writableEnded) {
              const remaining = transformStream(null); // flush
              if (remaining) res.write(remaining);
              res.end();
            }
          });
          proxyRes.on('error', err => {
            streamEnded = true;
            addLog('error', 'upstream stream error: ' + err.message);
            if (!res.writableEnded) res.end();
          });
        } else if (proxyRes.statusCode >= 400) {
          // Error response — read fully and return as JSON
          let data = '';
          proxyRes.on('data', c => { data += c.toString(); });
          proxyRes.on('end', () => {
            addLog('error', `upstream error ${proxyRes.statusCode}: ${data.substring(0, 200)}`);
            res.writeHead(proxyRes.statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(data);
          });
        } else {
          let data = '';
          proxyRes.on('data', c => { data += c.toString(); });
          proxyRes.on('end', () => {
            addLog('info', `response: ${proxyRes.statusCode}`);
            let output = data;
            try {
              output = transformOutput(data);
              addLog('debug', `output transform: ${data.substring(0, 200)} → ${output.substring(0, 200)}`);
            } catch (e) {
              addLog('error', 'output transform failed: ' + e.message);
            }
            res.writeHead(proxyRes.statusCode, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(output);
          });
        }
      });

      proxyReq.on('error', err => {
        if (!res.headersSent) {
          addLog('error', 'upstream connection failed: ' + err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Proxy request failed', message: err.message }));
        }
      });

      proxyReq.write(JSON.stringify(filtered));
      proxyReq.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON', message: err.message }));
    }
  });
}

function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const since = url.searchParams.get('since');
    let logs = logBuffer;
    if (since) {
      const idx = logBuffer.findIndex(l => l.time === since);
      logs = idx >= 0 ? logBuffer.slice(idx + 1) : logBuffer;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(logs));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      try {
        const updated = JSON.parse(body);
        config = { ...config, ...updated };
        saveConfig(config);
        addLog('info', 'config updated: ' + JSON.stringify(config));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  return false;
}

function serveUI(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Proxy Config</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1e1e2e;color:#cdd6f4;padding:24px;max-width:860px;margin:0 auto}
h1{font-size:20px;font-weight:600;margin-bottom:4px;color:#cba6f7}
.subtitle{font-size:12px;color:#6c7086;margin-bottom:24px}
.section{background:#181825;border:1px solid #313244;border-radius:8px;padding:16px;margin-bottom:16px}
.section-title{font-size:13px;font-weight:600;color:#a6e3a1;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
label{display:block;font-size:12px;color:#a6adc8;margin-bottom:4px}
input,textarea{width:100%;padding:8px 10px;background:#1e1e2e;border:1px solid #313244;border-radius:4px;color:#cdd6f4;font-size:13px;font-family:'SF Mono','Fira Code',monospace;outline:0}
input:focus,textarea:focus{border-color:#cba6f7}
textarea{resize:vertical;min-height:60px}
.row{display:flex;gap:12px}
.row>div{flex:1}
.hint{font-size:11px;color:#6c7086;margin-top:4px}
.status{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:16px}
.status.ok{background:#1e3a1e;color:#a6e3a1;border:1px solid #40a02b}
.status.err{background:#3a1e1e;color:#f38ba8;border:1px solid #d20f39}
.status-dot{width:8px;height:8px;border-radius:50%}
.status.ok .status-dot{background:#a6e3a1}
.status.err .status-dot{background:#f38ba8}
button{width:100%;padding:10px;background:#cba6f7;color:#1e1e2e;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#b4befe}
.tag-container{display:flex;flex-wrap:wrap;gap:6px;padding:8px;min-height:36px;background:#1e1e2e;border:1px solid #313244;border-radius:4px;margin-top:4px}
.tag{display:flex;align-items:center;gap:4px;background:#313244;color:#cdd6f4;padding:3px 8px;border-radius:4px;font-size:12px;font-family:monospace}
.tag .rm{cursor:pointer;color:#f38ba8;font-weight:700;margin-left:2px}
.add-param{display:flex;gap:6px;margin-top:6px}
.add-param input{flex:1}
.add-param button{width:auto;padding:6px 14px;font-size:12px}
#logViewer{background:#11111b;border:1px solid #313244;border-radius:4px;height:350px;overflow-y:auto;padding:8px;font-size:11px;font-family:'SF Mono','Fira Code',monospace;line-height:1.6}
.log-entry{display:flex;gap:8px;padding:1px 0;border-bottom:1px solid #1e1e2e}
.log-time{color:#585b70;flex-shrink:0;white-space:nowrap}
.log-level{flex-shrink:0;font-weight:600;width:36px;text-align:center}
.log-level.info{color:#89b4fa}
.log-level.debug{color:#6c7086}
.log-level.error{color:#f38ba8}
.log-msg{word-break:break-all;white-space:pre-wrap}
.log-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.log-toolbar button{width:auto;padding:4px 12px;font-size:11px;background:#313244}
.log-toolbar button:hover{background:#45475a}
.log-toolbar label{display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;margin:0}
.log-toolbar input[type=checkbox]{width:auto;accent-color:#cba6f7}
</style>
</head>
<body>
<h1>Codex Proxy</h1>
<p class="subtitle">Proxy server running on port ${PORT} — config changes apply immediately</p>
<div id="status" class="status ok"><span class="status-dot"></span><span id="statusText">Proxy running</span></div>

<div class="section">
<div class="section-title">Endpoint Config</div>
<div class="row">
<div><label>Listen Path</label><input id="listenPath" placeholder="/v1/responses"><p class="hint">Path to match incoming requests</p></div>
<div><label>Target URL</label><input id="targetUrl" placeholder="https://api.deepseek.com/chat/completions"><p class="hint">Where to forward requests</p></div>
</div>
<div class="row" style="margin-top:12px">
<div><label>Model Override</label><input id="modelOverride" placeholder="e.g. deepseek-chat"><p class="hint">Replace model field in proxied requests (leave empty to pass through)</p></div>
<div></div>
</div></div>

<div class="section">
<div class="section-title">Transform</div>
<label style="display:flex;align-items:center;gap:8px;cursor:pointer">
<input type="checkbox" id="enableInputTransform" style="width:auto;accent-color:#cba6f7">
Convert <code style="background:#313244;padding:1px 4px;border-radius:2px">input</code> → <code style="background:#313244;padding:1px 4px;border-radius:2px">messages</code> (Responses API → Chat Completions)
</label>
<p class="hint">Transforms content array (text/input_image) to standard chat message format</p>
</div>

<div class="section">
<div class="section-title">Body Filter Params</div>
<p class="hint" style="margin-bottom:8px">These top-level JSON keys will be removed before forwarding</p>
<div id="filterTags" class="tag-container"></div>
<div class="add-param"><input id="newParam" placeholder="e.g. tools"><button id="addParamBtn">Add</button></div>
</div>

<div class="section">
<div class="section-title">Test Request</div>
<textarea id="curlExample" readonly style="font-size:11px;min-height:80px"></textarea>
</div>

<div class="section">
<div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
<span>Proxy Logs</span>
<div class="log-toolbar" style="margin:0">
<label><input type="checkbox" id="autoScroll">Auto-scroll</label>
<button id="clearLogsBtn">Clear</button>
</div>
</div>
<div id="logViewer"><span style="color:#6c7086">Loading logs...</span></div>
</div>

<button id="saveBtn">Save Configuration</button>

<script>
const $=id=>document.getElementById(id);
let filterParams=[];
function setStatus(ok,t){$('status').className='status '+(ok?'ok':'err');$('statusText').textContent=t}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function render(){let h='';for(const p of filterParams)h+='<span class="tag">'+esc(p)+'<span class="rm" data-p="'+esc(p)+'">&times;</span></span>';$('filterTags').innerHTML=h}
function updateCurl(){const mo=$('modelOverride').value.trim();const b={model:mo||'gpt-3.5-turbo',messages:[{role:'user',content:'hello'}]};for(const p of filterParams){if(p==='tools')b.tools=[{type:'function',function:{name:'test'}}];if(p==='tool_choice')b.tool_choice='none'}
let tip='';if(mo)tip='  # model will be overridden to: '+mo+'\\n';$('curlExample').value=tip+'curl -X POST http://localhost:${PORT}'+$('listenPath').value+' -H "Content-Type: application/json" -H "Authorization: Bearer <KEY>" -d \\''+JSON.stringify(b)+'\\''}
async function load(){try{const r=await fetch('/api/config');const c=await r.json();$('listenPath').value=c.listenPath||'/v1/responses';$('targetUrl').value=c.targetUrl||'';$('modelOverride').value=c.modelOverride||'';filterParams=c.filterParams||[];$('enableInputTransform').checked=c.enableInputTransform!==false;render();updateCurl()}catch(e){setStatus(false,'Failed to load config: '+e.message)}}
async function save(){const c={listenPath:$('listenPath').value.trim(),targetUrl:$('targetUrl').value.trim(),modelOverride:$('modelOverride').value.trim(),filterParams,enableInputTransform:$('enableInputTransform').checked};try{const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});const j=await r.json();if(j.success)setStatus(true,'Saved');else setStatus(false,'Failed')}catch(e){setStatus(false,'Error: '+e.message)}}
function addParam(){const v=$('newParam').value.trim();if(v&&!filterParams.includes(v)){filterParams.push(v);$('newParam').value='';render();updateCurl()}}
$('addParamBtn').onclick=addParam;$('newParam').onkeydown=e=>{if(e.key==='Enter')addParam()};
$('filterTags').onclick=e=>{if(e.target.classList.contains('rm')){filterParams=filterParams.filter(p=>p!==e.target.dataset.p);render();updateCurl()}};
$('listenPath').oninput=updateCurl;$('targetUrl').oninput=updateCurl;$('modelOverride').oninput=updateCurl;$('saveBtn').onclick=save;
load();

// Log viewer
let logSince=null;
$('autoScroll').checked=true;
async function fetchLogs(){try{const url=logSince?'/api/logs?since='+encodeURIComponent(logSince):'/api/logs';const r=await fetch(url);const logs=await r.json();if(logs.length){logSince=logs[logs.length-1].time;appendLogs(logs)}}catch(e){console.error('log fetch error:',e)}
function appendLogs(logs){const v=$('logViewer'),wasAtBottom=v.scrollTop+v.clientHeight>=v.scrollHeight-4;let h=v.querySelector('span')?v.innerHTML='':0;for(const l of logs){h+=logEntry(l)}v.insertAdjacentHTML('beforeend',h);if($('autoScroll').checked||wasAtBottom)v.scrollTop=v.scrollHeight}
function logEntry(l){const time=l.time.slice(11,23);return'<div class="log-entry"><span class="log-time">'+time+'</span><span class="log-level '+l.level+'">'+l.level.toUpperCase()+'</span><span class="log-msg">'+esc(l.msg)+'</span></div>'}
}
fetchLogs();setInterval(fetchLogs,2000);
$('clearLogsBtn').onclick=()=>{$('logViewer').innerHTML='<span style="color:#6c7086">Cleared at '+new Date().toLocaleTimeString()+'</span>';logSince=null};
</script>
</script>
</body></html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === config.listenPath && req.method === 'POST') {
    handleProxy(req, res);
  } else if (handleAPI(req, res)) {
    // handled by API
  } else {
    serveUI(res);
  }
});

server.listen(PORT, () => {
  addLog('info', `Proxy server started on port ${PORT}`);
  addLog('info', `Endpoint: POST ${config.listenPath} → ${config.targetUrl}`);
  addLog('info', `Filter params: [${config.filterParams.join(', ')}]`);
  saveConfig(config);
});

module.exports = { server };
