const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const BOT_TOKEN      = process.env.BOT_TOKEN    || '';

// Dedupe automático — evita mandar 2× se o mesmo chat estiver repetido
const CHAT_IDS = [...new Set(
    (process.env.CHAT_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
)];

const CRON_SECRET    = process.env.CRON_SECRET  || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whk_recarga_2026';

const API_KEY = '87443981';

const API_URL            = `https://recargapro.gt.tc/api_recargas_x7k2.php?api_key=${API_KEY}&limit=200&order=desc`;
const API_PASSES_URL     = `https://recargapro.gt.tc/api_passes_x7k2.php?api_key=${API_KEY}&limit=200&order=desc`;
const API_PAGAMENTOS_URL = `https://recargapro.gt.tc/api_pagamentos_x7k2.php?api_key=${API_KEY}&limit=200&order=desc`;

const STATUS_OK          = ['pendente', 'andamento', 'feita'];
const STATUS_DEPOSITO_OK = 'approved';

const STATE_FILE            = '/tmp/bot_state.txt';
const STATE_FILE_PASSES     = '/tmp/bot_state_passes.txt';
const STATE_FILE_PAGAMENTOS = '/tmp/bot_state_pagamentos.txt';

// ================== GUARD CONTRA EXECUÇÃO DUPLICADA ==================
let   __checkRunning   = false;
let   __lastRunAt      = 0;
const MIN_RUN_INTERVAL = 20000; // 20s — cobre o tempo do Puppeteer + folga

// ================== LOG ==================
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================== HELPERS ==================
function extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (e) {}
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b > a) {
        try { return JSON.parse(text.substring(a, b + 1)); } catch (e) {}
    }
    return null;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function fmtData(dtStr) {
    try {
        const dt = new Date(String(dtStr).replace(' ','T') + '-03:00');
        return new Date(dt.getTime()+4*3600*1000).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'});
    } catch(e){ return '—'; }
}
function fmtMoeda(v) { return Number(v||0).toFixed(2).replace('.', ','); }

// ================== PUPPETEER ==================
async function fetchWithPuppeteer(url) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer'],
            ignoreHTTPSErrors: true,
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Authorization': `Bearer ${API_KEY}`,
            'X-API-Key':     API_KEY,
        });
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        await sleep(2500);
        const bodyText = await page.evaluate(() => document.body.innerText.trim());
        const j = extractJson(bodyText);
        if (!j) throw new Error('JSON não encontrado: ' + bodyText.substring(0, 100));
        return j;
    } finally {
        if (browser) await browser.close();
    }
}

// ================== TELEGRAM ==================
async function tg(method, payload) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return resp.json();
}

async function sendToAll(text) {
    let ok = true;
    for (const chatId of CHAT_IDS) {
        try {
            const r = await tg('sendMessage', {
                chat_id: chatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            if (!r.ok) { log(`ERRO msg → ${chatId}: ${JSON.stringify(r).substring(0,150)}`); ok = false; }
            await sleep(300);
        } catch(e){ log(`ERRO msg: ${e.message}`); ok = false; }
    }
    return ok;
}

// ================== FORMAT RECARGAS ==================
function formatOrderNew(o) {
    return `🎮 <b>Novo Pedido #${o.id}</b>\n\n`
         + `👤 <b>Revendedor:</b> ${esc(o.revendedor?.nome||'N/A')}\n`
         + `📧 <b>Email:</b> ${esc(o.revendedor?.email||'N/A')}\n`
         + `📱 <b>Telefone:</b> ${esc(o.telefone_formatado||o.telefone)}\n`
         + `📡 <b>Operadora:</b> ${(o.operadora||'').toUpperCase()}\n\n`
         + `💰 <b>Valor:</b> R$ ${fmtMoeda(o.valor)}\n`
         + `💸 <b>Custo:</b> R$ ${fmtMoeda(o.custo)}\n\n`
         + `📊 <b>Status:</b> ${cap(o.status)}\n`
         + `🕐 <b>Data:</b> ${fmtData(o.criado_em)}`;
}

function formatOrderChanged(o, anterior) {
    return `🔄 <b>Pedido #${o.id}</b> — status alterado\n\n`
         + `👤 <b>Revendedor:</b> ${esc(o.revendedor?.nome||'N/A')}\n`
         + `📱 <b>Telefone:</b> ${esc(o.telefone_formatado||o.telefone)}\n`
         + `📡 <b>Operadora:</b> ${(o.operadora||'').toUpperCase()}\n\n`
         + `📊 <b>Status:</b> ${cap(anterior)} → <b>${cap(o.status).toUpperCase()}</b>\n`
         + `💰 <b>Valor:</b> R$ ${fmtMoeda(o.valor)}\n`
         + `🕐 <b>Atualizado:</b> ${fmtData(o.atualizado_em || new Date().toISOString())}`;
}

// ================== FORMAT PASSES ==================
function formatPasseNew(p) {
    return `🎟️ <b>Novo Passe FF #${p.id}</b>\n\n`
         + `👤 <b>Revendedor:</b> ${esc(p.revendedor?.nome||'N/A')}\n`
         + `📧 <b>Email:</b> ${esc(p.revendedor?.email||'N/A')}\n`
         + `🎮 <b>Player ID:</b> <code>${esc(p.player_id)}</code>\n`
         + `🏷️ <b>Nick:</b> ${esc(p.nick)}\n\n`
         + `💰 <b>Valor:</b> R$ ${fmtMoeda(p.valor)}\n`
         + `💸 <b>Custo:</b> R$ ${fmtMoeda(p.custo)}\n\n`
         + `📊 <b>Status:</b> ${cap(p.status)}\n`
         + `🕐 <b>Data:</b> ${fmtData(p.criado_em)}`;
}

function formatPasseChanged(p, anterior) {
    return `🔄 <b>Passe FF #${p.id}</b> — status alterado\n\n`
         + `👤 <b>Revendedor:</b> ${esc(p.revendedor?.nome||'N/A')}\n`
         + `🎮 <b>Player ID:</b> <code>${esc(p.player_id)}</code>\n`
         + `🏷️ <b>Nick:</b> ${esc(p.nick)}\n\n`
         + `📊 <b>Status:</b> ${cap(anterior)} → <b>${cap(p.status).toUpperCase()}</b>\n`
         + `💰 <b>Valor:</b> R$ ${fmtMoeda(p.valor)}\n`
         + `🕐 <b>Atualizado:</b> ${fmtData(p.atualizado_em || new Date().toISOString())}`;
}

// ================== FORMAT DEPÓSITOS ==================
function formatDeposito(p, anterior) {
    const novo = !anterior;
    const titulo = novo
        ? `💰 <b>Novo Depósito #${p.id}</b>`
        : `💰 <b>Depósito Aprovado #${p.id}</b>`;
    const statusLine = novo
        ? `📊 <b>Status:</b> <b>Approved</b>`
        : `📊 <b>Status:</b> ${cap(anterior)} → <b>Approved</b>`;

    return `${titulo}\n\n`
         + `👤 <b>Revendedor:</b> ${esc(p.revendedor?.nome||'N/A')}\n`
         + `📧 <b>Email:</b> ${esc(p.revendedor?.email||'N/A')}\n`
         + `💳 <b>Valor:</b> R$ ${fmtMoeda(p.valor)}\n`
         + (p.mp_payment_id ? `🆔 <b>MP ID:</b> <code>${esc(p.mp_payment_id)}</code>\n` : '')
         + `\n${statusLine}\n`
         + `🕐 <b>Data:</b> ${fmtData(p.atualizado_em || p.criado_em || new Date().toISOString())}`;
}

// ================== STATE ==================
function loadState(file) {
    try {
        if (!fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw) return null;
        if (/^\d+$/.test(raw)) return { lastId: parseInt(raw, 10), statuses: {} };
        const j = JSON.parse(raw);
        if (typeof j.lastId === 'number' && j.statuses && typeof j.statuses === 'object') return j;
    } catch(e){ log('Erro load state '+file+': '+e.message); }
    return null;
}

// Atomic write — evita JSON corrompido se 2 processos escreverem ao mesmo tempo
function saveState(file, state) {
    try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, file);
        return true;
    } catch(e){
        log('Erro save state '+file+': '+e.message);
        return false;
    }
}

function buildStatuses(items, statusField) {
    const s = {};
    for (const it of items) s[it.id] = it[statusField || 'status'];
    return s;
}

// ================== VERIFICAÇÃO GENÉRICA (recargas/passes) ==================
async function verificarLista({ label, url, stateFile, formatNew, formatChanged }) {
    log(`=== Verificando ${label} ===`);
    if (!BOT_TOKEN)            { log('ERRO: BOT_TOKEN ausente'); return; }
    if (CHAT_IDS.length === 0) { log('ERRO: CHAT_IDS ausente'); return; }

    let json;
    try { json = await fetchWithPuppeteer(url); }
    catch (e) { log(`ERRO fetch ${label}: ` + e.message); return; }

    if (!json.success || !Array.isArray(json.data)) {
        log(`ERRO resposta ${label}: ` + JSON.stringify(json).substring(0,200));
        return;
    }
    const items = json.data;
    if (items.length === 0) { log(`API ${label} vazia`); return; }

    const maxId = Math.max(...items.map(it => parseInt(it.id, 10)));

    const state = loadState(stateFile);
    if (!state) {
        saveState(stateFile, { lastId: maxId, statuses: buildStatuses(items) });
        log(`${label} — primeira execução: maxId=${maxId} salvo. Não notifica.`);
        return;
    }

    const novos     = [];
    const alterados = [];

    for (const it of items) {
        const id = parseInt(it.id, 10);
        if (id > state.lastId) {
            if (STATUS_OK.includes(it.status)) novos.push(it);
        } else if (state.statuses[id] && state.statuses[id] !== it.status) {
            alterados.push({ item: it, anterior: state.statuses[id] });
        }
    }

    novos.sort((a,b) => parseInt(a.id,10) - parseInt(b.id,10));
    alterados.sort((a,b) => parseInt(a.item.id,10) - parseInt(b.item.id,10));

    log(`${label} — novos: ${novos.length} | alterados: ${alterados.length} | maxId: ${maxId}`);

    // ✅ SALVA ANTES DE ENVIAR — evita duplicar se crashar no meio do envio
    const okSave = saveState(stateFile, {
        lastId: Math.max(state.lastId, maxId),
        statuses: buildStatuses(items),
    });
    if (!okSave) {
        log(`${label} — ABORTANDO envio: falha ao salvar state (evita duplicata na próxima)`);
        return;
    }

    // Agora sim envia. Se um envio falhar, loga e segue — não reenvia na próxima.
    for (const it of novos) {
        const sent = await sendToAll(formatNew(it));
        log(`${label} → novo #${it.id} ${sent ? '✓' : '⚠️ falha parcial'}`);
    }
    for (const { item, anterior } of alterados) {
        const sent = await sendToAll(formatChanged(item, anterior));
        log(`${label} → alteração #${item.id} (${anterior} → ${item.status}) ${sent ? '✓' : '⚠️ falha parcial'}`);
    }

    log(`=== ${label} concluído ===`);
}

async function verificarPedidos() {
    return verificarLista({
        label: 'RECARGAS',
        url: API_URL,
        stateFile: STATE_FILE,
        formatNew: formatOrderNew,
        formatChanged: formatOrderChanged,
    });
}

async function verificarPasses() {
    return verificarLista({
        label: 'PASSES FF',
        url: API_PASSES_URL,
        stateFile: STATE_FILE_PASSES,
        formatNew: formatPasseNew,
        formatChanged: formatPasseChanged,
    });
}

// ================== VERIFICAÇÃO DEPÓSITOS ==================
async function verificarDepositos() {
    log('=== Verificando DEPÓSITOS ===');
    if (!BOT_TOKEN)            { log('ERRO: BOT_TOKEN ausente'); return; }
    if (CHAT_IDS.length === 0) { log('ERRO: CHAT_IDS ausente'); return; }

    let json;
    try { json = await fetchWithPuppeteer(API_PAGAMENTOS_URL); }
    catch (e) { log('ERRO fetch pagamentos: ' + e.message); return; }

    if (!json.success || !Array.isArray(json.data)) {
        log('ERRO resposta pagamentos: ' + JSON.stringify(json).substring(0,200));
        return;
    }
    const pagamentos = json.data;
    if (pagamentos.length === 0) { log('API pagamentos vazia'); return; }

    const maxId = Math.max(...pagamentos.map(p => parseInt(p.id, 10)));

    const state = loadState(STATE_FILE_PAGAMENTOS);
    if (!state) {
        saveState(STATE_FILE_PAGAMENTOS, {
            lastId: maxId,
            statuses: buildStatuses(pagamentos, 'mp_status'),
        });
        log(`Pagamentos — primeira execução: maxId=${maxId} salvo. Não notifica.`);
        return;
    }

    const novosAprovados = [];
    const aprovadosAgora = [];

    for (const p of pagamentos) {
        const id           = parseInt(p.id, 10);
        const statusAtual  = p.mp_status;
        const statusAntigo = state.statuses[id];

        if (id > state.lastId) {
            if (statusAtual === STATUS_DEPOSITO_OK) novosAprovados.push(p);
        } else if (statusAntigo && statusAntigo !== statusAtual) {
            if (statusAtual === STATUS_DEPOSITO_OK) aprovadosAgora.push({ item: p, anterior: statusAntigo });
        }
    }

    novosAprovados.sort((a,b) => parseInt(a.id,10) - parseInt(b.id,10));
    aprovadosAgora.sort((a,b) => parseInt(a.item.id,10) - parseInt(b.item.id,10));

    log(`Pagamentos — novos aprovados: ${novosAprovados.length} | aprovados agora: ${aprovadosAgora.length} | maxId: ${maxId}`);

    // ✅ SALVA ANTES DE ENVIAR
    const okSave = saveState(STATE_FILE_PAGAMENTOS, {
        lastId: Math.max(state.lastId, maxId),
        statuses: buildStatuses(pagamentos, 'mp_status'),
    });
    if (!okSave) {
        log('Pagamentos — ABORTANDO envio: falha ao salvar state');
        return;
    }

    for (const p of novosAprovados) {
        const sent = await sendToAll(formatDeposito(p, null));
        log(`DEPÓSITOS → novo #${p.id} (R$ ${fmtMoeda(p.valor)}) ${sent ? '✓' : '⚠️ falha parcial'}`);
    }
    for (const { item, anterior } of aprovadosAgora) {
        const sent = await sendToAll(formatDeposito(item, anterior));
        log(`DEPÓSITOS → #${item.id} (${anterior} → approved, R$ ${fmtMoeda(item.valor)}) ${sent ? '✓' : '⚠️ falha parcial'}`);
    }

    log('=== DEPÓSITOS concluído ===');
}

// ================== EXECUTOR COM MUTEX + COOLDOWN ==================
async function runAllChecks() {
    // 1) Já está rodando? Recusa imediatamente (evita sobreposição)
    if (__checkRunning) {
        log('⚠️ Check já em execução — chamada ignorada (evita duplicata)');
        return { ok: false, reason: 'busy' };
    }

    // 2) Cooldown — se rodou há menos de 20s, ignora (evita múltiplas fontes de cron)
    const now = Date.now();
    const sinceLast = now - __lastRunAt;
    if (__lastRunAt > 0 && sinceLast < MIN_RUN_INTERVAL) {
        log(`⚠️ Check rodou há ${Math.round(sinceLast/1000)}s — cooldown (${MIN_RUN_INTERVAL/1000}s). Ignorado.`);
        return { ok: false, reason: 'cooldown' };
    }

    __checkRunning = true;
    __lastRunAt    = now;

    try {
        try { await verificarPedidos(); }
        catch(e){ log('Erro verificarPedidos: ' + e.message); }

        try { await verificarPasses(); }
        catch(e){ log('Erro verificarPasses: ' + e.message); }

        try { await verificarDepositos(); }
        catch(e){ log('Erro verificarDepositos: ' + e.message); }

        return { ok: true };
    } finally {
        __checkRunning = false;
    }
}

// ================== WEBHOOK ==================
app.post('/webhook', async (req, res) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return res.status(403).send('Forbidden');
    res.send('OK');

    const upd = req.body;
    if (!upd) return;

    if (upd.message) {
        const chatId = upd.message.chat?.id;
        const text   = upd.message.text || '';
        if (text.startsWith('/start')) {
            await tg('sendMessage', {
                chat_id: chatId,
                text: '🤖 Bot RecargaPro ativo!\nVocê receberá notificações de novos pedidos, passes FF e depósitos aprovados.',
            });
        } else if (text.startsWith('/chatid')) {
            await tg('sendMessage', { chat_id: chatId, text: `Seu Chat ID: <code>${chatId}</code>`, parse_mode: 'HTML' });
        }
        return;
    }

    if (upd.callback_query) {
        const cq = upd.callback_query;
        try {
            await tg('answerCallbackQuery', {
                callback_query_id: cq.id,
                text: '⚠️ Botões desativados. Atualize o status pelo painel admin.',
                show_alert: true,
            });
            await tg('editMessageReplyMarkup', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                reply_markup: { inline_keyboard: [] },
            });
        } catch(e){ log('Erro callback: ' + e.message); }
    }
});

// ================== WEBHOOK ADMIN ==================
app.get('/setwebhook', async (req, res) => {
    const secret = req.query.secret;
    if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).send('Forbidden');
    const url = `https://${req.get('host')}/webhook`;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(url)}&secret_token=${encodeURIComponent(WEBHOOK_SECRET)}`);
    const j = await r.json();
    res.json({ webhook_url: url, telegram: j });
});

app.get('/delwebhook', async (req, res) => {
    const secret = req.query.secret;
    if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).send('Forbidden');
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
    res.json(await r.json());
});

// ================== ROTAS ==================
const checkHandler = async (req, res) => {
    const secret = req.query.secret || req.headers['x-cron-secret'];
    if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).send('Forbidden');

    const r = await runAllChecks();
    if (r.ok) res.send('OK');
    else      res.status(202).send(r.reason || 'ignored'); // 202 = recebido mas não processado
};

app.get('/',                 (req,res)=>res.send('Bot RecargaPro — Online'));
app.get('/health',           (req,res)=>res.send('OK'));
app.get('/ping',             checkHandler);
app.get('/bot_telegram.php', checkHandler); // mantido — mas agora protegido pelo mesmo mutex

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log(`Servidor rodando na porta ${PORT}`);
    if (!CRON_SECRET)    log('⚠️ AVISO: CRON_SECRET vazio — /ping acessível a qualquer um. Defina a variável!');
    if (!BOT_TOKEN)      log('⚠️ AVISO: BOT_TOKEN vazio — notificações não serão enviadas.');
    if (!CHAT_IDS.length) log('⚠️ AVISO: CHAT_IDS vazio — sem destinatários.');
    log(`Chat IDs únicos: ${CHAT_IDS.join(', ') || '(nenhum)'}`);
});
