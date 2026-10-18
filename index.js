const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const CHAT_IDS     = (process.env.CHAT_IDS    || '').split(',').map(s => s.trim()).filter(Boolean);
const CRON_SECRET  = process.env.CRON_SECRET  || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whk_recarga_2026';

const API_KEY         = '87443981';
const API_BASE        = 'https://recargapro.gt.tc/api_recargas_x7k2.php';
const API_URL         = `${API_BASE}?api_key=${API_KEY}&limit=100&order=desc`;
const API_UPDATE_BASE = 'https://recargapro.gt.tc/api_atualizar_status.php';

const STATUS_OK  = ['pendente', 'andamento', 'feita'];
const STATE_FILE = '/tmp/bot_state.txt';

// ================== LOG ==================
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ================== JSON EXTRACT ==================
function extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    try { return JSON.parse(text); } catch (e) {}
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b > a) {
        try { return JSON.parse(text.substring(a, b + 1)); } catch (e) {}
    }
    return null;
}

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
        log('Navegando para API...');
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        const bodyText = await page.evaluate(() => document.body.innerText.trim());
        log('Resposta (200 chars): ' + bodyText.substring(0, 200).replace(/\n/g, ' '));
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

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function formatOrder(o) {
    const emoji = { pendente:'⏳', andamento:'🔄', feita:'✅' }[o.status] || '📦';
    const val = Number(o.valor||0).toFixed(2).replace('.',',');
    const cus = Number(o.custo||0).toFixed(2).replace('.',',');
    const luc = (Number(o.valor||0)-Number(o.custo||0)).toFixed(2).replace('.',',');

    let dtStr = '—';
    try {
        const dt = new Date(o.criado_em.replace(' ','T') + '-03:00');
        dtStr = new Date(dt.getTime()+4*3600*1000).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'});
    } catch(e){}

    return `${emoji} <b>Novo Pedido #${o.id}</b>\n\n`
         + `👤 <b>Revendedor:</b> ${esc(o.revendedor?.nome||'N/A')}\n`
         + `📧 <b>Email:</b> ${esc(o.revendedor?.email||'N/A')}\n`
         + `📱 <b>Telefone:</b> ${esc(o.telefone_formatado||o.telefone)}\n`
         + `📡 <b>Operadora:</b> ${(o.operadora||'').toUpperCase()}\n\n`
         + `💰 <b>Valor:</b> R$ ${val}\n`
         + `💸 <b>Custo:</b> R$ ${cus}\n`
         + `📈 <b>Lucro:</b> R$ ${luc}\n\n`
         + `📊 <b>Status:</b> ${cap(o.status)}\n`
         + `🕐 <b>Data:</b> ${dtStr}`;
}

function inlineKeyboard(orderId, currentStatus) {
    const btn = (label, status) => ({
        text: label,
        callback_data: `st:${orderId}:${status}`,
    });
    // Agrupa em 2 linhas
    return {
        inline_keyboard: [
            [ btn('⏳ Pendente', 'pendente'), btn('🔄 Andamento', 'andamento'), btn('✅ Feita', 'feita') ],
            [ btn('❌ Cancelar', 'cancelada'), btn('⌛ Expirada', 'expirada') ],
        ],
    };
}

// ================== STATE ==================
function getLastId() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const v = fs.readFileSync(STATE_FILE, 'utf8').trim();
            return v === '' ? null : parseInt(v, 10);
        }
    } catch(e){ log('Erro state: '+e.message); }
    return null;
}
function setLastId(id) {
    try { fs.writeFileSync(STATE_FILE, String(id)); } catch(e){ log('Erro state: '+e.message); }
}

// ================== VERIFICAÇÃO ==================
async function verificarPedidos() {
    log('=== Verificando novos pedidos ===');
    if (!BOT_TOKEN)            { log('ERRO: BOT_TOKEN ausente'); return; }
    if (CHAT_IDS.length === 0) { log('ERRO: CHAT_IDS ausente'); return; }

    let json;
    try { json = await fetchWithPuppeteer(API_URL); }
    catch (e) { log('ERRO no fetch: '+e.message); return; }

    if (!json.success || !Array.isArray(json.data)) {
        log('ERRO: resposta inválida — '+JSON.stringify(json).substring(0,200));
        return;
    }
    const pedidos = json.data;
    if (pedidos.length === 0) { log('API vazia'); return; }

    const maxId = Math.max(...pedidos.map(p => parseInt(p.id,10)));
    log(`Total: ${pedidos.length} | Maior ID: ${maxId}`);

    const lastId = getLastId();
    if (lastId === null) {
        setLastId(maxId);
        log(`Primeira execução: maxId=${maxId} salvo. Não notifica.`);
        return;
    }

    const novos = pedidos
        .filter(p => parseInt(p.id,10) > lastId && STATUS_OK.includes(p.status))
        .sort((a,b) => parseInt(a.id,10) - parseInt(b.id,10));

    log(`Último ID visto: ${lastId} | Novos: ${novos.length}`);
    if (novos.length === 0) { log('Nada a notificar'); return; }

    for (const p of novos) {
        const msg = formatOrder(p);
        const kb  = inlineKeyboard(p.id, p.status);
        let ok = true;

        for (const chatId of CHAT_IDS) {
            try {
                const r = await tg('sendMessage', {
                    chat_id: chatId,
                    text: msg,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    reply_markup: kb,
                });
                if (!r.ok) { log(`ERRO #${p.id} → ${chatId}: ${JSON.stringify(r).substring(0,150)}`); ok=false; }
                else       log(`✓ Pedido #${p.id} enviado para ${chatId}`);
                await new Promise(r => setTimeout(r, 300));
            } catch(e){ log(`ERRO #${p.id}: ${e.message}`); ok=false; }
        }
        if (ok) setLastId(parseInt(p.id,10));
    }
    log('=== Concluído ===');
}

// ================== UPDATE STATUS (Puppeteer resolve o anti-bot) ==================
async function atualizarStatus(id, status) {
    const url = `${API_UPDATE_BASE}?api_key=${API_KEY}&id=${id}&status=${status}&origem=bot`;
    log(`Atualizando #${id} → ${status}`);
    try {
        // Usa a MESMA função que lista pedidos — ela já resolve o AES
        const j = await fetchWithPuppeteer(url);
        log('API update: ' + JSON.stringify(j).substring(0, 200));
        return j;
    } catch (e) {
        log('Erro update: ' + e.message);
        return { success: false, error: { message: e.message } };
    }
}

// ================== WEBHOOK ==================
app.post('/webhook', async (req, res) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
        return res.status(403).send('Forbidden');
    }
    res.send('OK');   // responde rápido; processa depois

    const upd = req.body;
    if (!upd) return;

    // Mensagem de texto normal (para /start, /chatid)
    if (upd.message) {
        const chatId = upd.message.chat?.id;
        const text   = upd.message.text || '';
        if (text.startsWith('/start')) {
            await tg('sendMessage', { chat_id: chatId, text: '🤖 Bot RecargaPro ativo!\nVocê receberá notificações de novos pedidos aqui.' });
        } else if (text.startsWith('/chatid')) {
            await tg('sendMessage', { chat_id: chatId, text: `Seu Chat ID: <code>${chatId}</code>`, parse_mode: 'HTML' });
        }
        return;
    }

    // Clique em botão inline
    if (upd.callback_query) {
        const cq = upd.callback_query;
        const data = cq.data || '';
        const m = data.match(/^st:(\d+):([a-z]+)$/);
        if (!m) return;

        const orderId    = parseInt(m[1], 10);
        const novoStatus = m[2];
        const chatId     = cq.message.chat.id;
        const msgId      = cq.message.message_id;
        const original   = cq.message.text || '';

        // Responde "carregando" ao Telegram (obrigatório em 3s)
        await tg('answerCallbackQuery', {
            callback_query_id: cq.id,
            text: `Atualizando #${orderId} para ${cap(novoStatus)}...`,
        });

        // Chama a API PHP
        const resultado = await atualizarStatus(orderId, novoStatus);

        if (!resultado.success) {
            await tg('sendMessage', {
                chat_id: chatId,
                text: `❌ Erro ao atualizar #${orderId}: ${resultado.error?.message || 'desconhecido'}`,
            });
            return;
        }

        // Atualiza emoji do título da mensagem original
        const emojiNovo = { pendente:'⏳', andamento:'🔄', feita:'✅', cancelada:'❌', expirada:'⌛' }[novoStatus] || '📦';
        let novoTexto = original
            .replace(/^[⏳🔄✅❌⌛📦]\s*/, emojiNovo + ' ')
            .replace(/(📊 <b>Status:<\/b>\s*)\w+/i, `$1${cap(novoStatus)}`);

        // Adiciona rodapé com quem mudou e quando
        const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
        const rodape = `\n\n✔️ Alterado para <b>${cap(novoStatus).toUpperCase()}</b> por você às ${hora}`;

        // Se já tem rodapé anterior, remove antes de adicionar (permite mudar várias vezes)
        novoTexto = novoTexto.replace(/\n\n✔️ Alterado para [^\n]*/g, '');
        novoTexto += rodape;

        // Edita a mensagem (remove botões após o clique — limita a uma ação por vez)
        await tg('editMessageText', {
            chat_id: chatId,
            message_id: msgId,
            text: novoTexto,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: inlineKeyboard(orderId, novoStatus),
        });

        // Envia confirmação no chat
        const extra = resultado.mudou_saldo && resultado.mudou_saldo !== 'nenhum'
            ? ` Saldo ${resultado.mudou_saldo === 'devolvido' ? 'devolvido' : 'cobrado'}: R$ ${Number(resultado.status_anterior==='feita'?0:0).toFixed(2)}.`
            : '';
        const emailMsg = resultado.email_enviado ? ' ✉️ E-mail enviado ao cliente.' : '';
        await tg('sendMessage', {
            chat_id: chatId,
            text: `✅ Pedido <b>#${orderId}</b> → <b>${cap(novoStatus).toUpperCase()}</b>.${emailMsg}${extra}`,
            parse_mode: 'HTML',
        });
    }
});

// Configurar webhook
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

// ================== ROTAS ANTIGAS ==================
const checkHandler = async (req, res) => {
    const secret = req.query.secret || req.headers['x-cron-secret'];
    if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).send('Forbidden');
    try { await verificarPedidos(); res.send('OK'); }
    catch(e){ log('ERRO geral: '+e.message); res.status(500).send('Erro: '+e.message); }
};

app.get('/',                 (req,res)=>res.send('Bot RecargaPro — Online'));
app.get('/health',           (req,res)=>res.send('OK'));
app.get('/ping',             checkHandler);
app.get('/bot_telegram.php', checkHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`Servidor rodando na porta ${PORT}`));
