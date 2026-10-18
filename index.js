const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();

// ================== CONFIG ==================
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const CHAT_IDS     = (process.env.CHAT_IDS    || '').split(',').map(s => s.trim()).filter(Boolean);
const CRON_SECRET  = process.env.CRON_SECRET  || '';

// Chave da API no header + query (redundância caso hospedagem filtre a query)
const API_KEY  = '87443981';
const API_BASE = 'https://recargapro.gt.tc/api_recargas_x7k2.php';
const API_URL  = `${API_BASE}?api_key=${API_KEY}&limit=100&order=desc`;

const STATUS_OK  = ['pendente', 'andamento', 'feita'];
const STATE_FILE = '/tmp/bot_state.txt';

// ================== LOG ==================
function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ================== EXTRAI JSON DO MEIO DO TEXTO ==================
function extractJson(text) {
    if (!text || typeof text !== 'string') return null;

    // Tenta direto
    try { return JSON.parse(text); } catch (e) {}

    // Se tem HTML antes do JSON, extrai do primeiro { até o último }
    const first = text.indexOf('{');
    const last  = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
        const candidate = text.substring(first, last + 1);
        try {
            return JSON.parse(candidate);
        } catch (e) {}
    }
    return null;
}

// ================== FETCH COM PUPPETEER ==================
async function fetchWithPuppeteer(url) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
            ],
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        // 1) User-Agent de navegador real
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // 2) Envia a chave via HEADER (redundância caso a query seja filtrada)
        await page.setExtraHTTPHeaders({
            'Authorization': `Bearer ${API_KEY}`,
            'X-API-Key':     API_KEY,
        });

        log('Navegando para API...');
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

        // Aguarda o desafio AES ser resolvido
        await new Promise(r => setTimeout(r, 2500));

        const bodyText = await page.evaluate(() => document.body.innerText.trim());
        log('Resposta bruta (200 chars): ' + bodyText.substring(0, 200).replace(/\n/g, ' '));

        const json = extractJson(bodyText);
        if (!json) {
            throw new Error('JSON não encontrado na resposta: ' + bodyText.substring(0, 100));
        }
        return json;
    } finally {
        if (browser) await browser.close();
    }
}

// ================== TELEGRAM ==================
async function sendTelegram(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    return resp.json();
}

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function formatOrder(o) {
    const emoji = { pendente: '⏳', andamento: '🔄', feita: '✅' }[o.status] || '📦';
    const val = Number(o.valor || 0).toFixed(2).replace('.', ',');
    const cus = Number(o.custo || 0).toFixed(2).replace('.', ',');
    const luc = (Number(o.valor || 0) - Number(o.custo || 0)).toFixed(2).replace('.', ',');

    let dataStr = '—';
    try {
        const dt = new Date(o.criado_em.replace(' ', 'T') + '-03:00');
        const dtAdj = new Date(dt.getTime() + 4 * 3600 * 1000);
        dataStr = dtAdj.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    } catch (e) {}

    return `${emoji} <b>Novo Pedido #${o.id}</b>\n\n`
         + `👤 <b>Revendedor:</b> ${esc(o.revendedor?.nome || 'N/A')}\n`
         + `📧 <b>Email:</b> ${esc(o.revendedor?.email || 'N/A')}\n`
         + `📱 <b>Telefone:</b> ${esc(o.telefone_formatado || o.telefone)}\n`
         + `📡 <b>Operadora:</b> ${(o.operadora || '').toUpperCase()}\n\n`
         + `💰 <b>Valor:</b> R$ ${val}\n`
         + `💸 <b>Custo:</b> R$ ${cus}\n`
         + `📈 <b>Lucro:</b> R$ ${luc}\n\n`
         + `📊 <b>Status:</b> ${cap(o.status)}\n`
         + `🕐 <b>Data:</b> ${dataStr}`;
}

// ================== STATE ==================
function getLastId() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const v = fs.readFileSync(STATE_FILE, 'utf8').trim();
            return v === '' ? null : parseInt(v, 10);
        }
    } catch (e) { log('Erro state: ' + e.message); }
    return null;
}
function setLastId(id) {
    try { fs.writeFileSync(STATE_FILE, String(id)); } catch (e) { log('Erro state: ' + e.message); }
}

// ================== MAIN ==================
async function verificarPedidos() {
    log('=== Verificando novos pedidos ===');

    if (!BOT_TOKEN)            { log('ERRO: BOT_TOKEN ausente'); return; }
    if (CHAT_IDS.length === 0) { log('ERRO: CHAT_IDS ausente'); return; }

    let json;
    try {
        json = await fetchWithPuppeteer(API_URL);
    } catch (e) {
        log('ERRO no fetch: ' + e.message);
        return;
    }

    if (!json.success || !Array.isArray(json.data)) {
        log('ERRO: resposta inválida — ' + JSON.stringify(json).substring(0, 200));
        return;
    }

    const pedidos = json.data;
    if (pedidos.length === 0) { log('API vazia'); return; }

    const maxId = Math.max(...pedidos.map(p => parseInt(p.id, 10)));
    log(`Total: ${pedidos.length} | Maior ID: ${maxId}`);

    const lastId = getLastId();

    if (lastId === null) {
        setLastId(maxId);
        log(`Primeira execução: maxId=${maxId} salvo. Não notifica.`);
        return;
    }

    const novos = pedidos
        .filter(p => parseInt(p.id, 10) > lastId && STATUS_OK.includes(p.status))
        .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    log(`Último ID visto: ${lastId} | Novos: ${novos.length}`);

    if (novos.length === 0) { log('Nada a notificar'); return; }

    for (const p of novos) {
        const msg = formatOrder(p);
        let ok = true;

        for (const chatId of CHAT_IDS) {
            try {
                const r = await sendTelegram(chatId, msg);
                if (!r.ok) {
                    log(`ERRO #${p.id} → ${chatId}: ${JSON.stringify(r).substring(0, 150)}`);
                    ok = false;
                } else {
                    log(`✓ Pedido #${p.id} enviado para ${chatId}`);
                }
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                log(`ERRO #${p.id}: ${e.message}`);
                ok = false;
            }
        }
        if (ok) setLastId(parseInt(p.id, 10));
    }

    log('=== Concluído ===');
}

// ================== ROTAS ==================
const checkHandler = async (req, res) => {
    const secret = req.query.secret || req.headers['x-cron-secret'];
    if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).send('Forbidden');

    try {
        await verificarPedidos();
        res.send('OK');
    } catch (e) {
        log('ERRO geral: ' + e.message);
        res.status(500).send('Erro: ' + e.message);
    }
};

const chatIdHandler = async (req, res) => {
    const secret = req.query.secret || req.headers['x-cron-secret'];
    if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).send('Forbidden');

    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=20`);
        const data = await r.json();

        if (!data.ok) return res.send('Erro Telegram: ' + JSON.stringify(data));
        if (!data.result || data.result.length === 0) {
            return res.send('Envie /start para o bot no Telegram e recarregue.');
        }

        const seen = new Set();
        const lines = ['=== CHAT IDs ENCONTRADOS ===', ''];
        for (const u of data.result) {
            const m = u.message || u.channel_post;
            if (!m) continue;
            const id = m.chat?.id;
            if (id == null || seen.has(id)) continue;
            seen.add(id);
            lines.push(`Chat ID: ${id}`);
            lines.push(`Tipo:    ${m.chat.type}`);
            lines.push(`Nome:    ${m.chat.first_name || m.chat.title || ''}`);
            lines.push('-----------------------------------');
        }
        res.send(lines.join('\n'));
    } catch (e) {
        res.send('Erro: ' + e.message);
    }
};

app.get('/',                 (req, res) => res.send('Bot RecargaPro — Online'));
app.get('/health',           (req, res) => res.send('OK'));
app.get('/ping',             checkHandler);
app.get('/bot_telegram.php', checkHandler);
app.get('/chatid',           chatIdHandler);
app.get('/get_chat_id.php',  chatIdHandler);

// ================== START ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`Servidor rodando na porta ${PORT}`));
