<?php
/**
 * Bot Telegram — Notificador de Novos Pedidos
 * Roda no Render como Web Service + cron-job.org
 *
 * Env vars necessárias:
 *   BOT_TOKEN    → do @BotFather
 *   CHAT_IDS     → seu chat_id
 *   CRON_SECRET  → senha para acionar via URL
 */

date_default_timezone_set('America/Fortaleza');

// ---------- Config ----------
$BOT_TOKEN = getenv('BOT_TOKEN') ?: '';
$CHAT_IDS  = array_filter(array_map('trim', explode(',', getenv('CHAT_IDS') ?: '')));
$SECRET    = getenv('CRON_SECRET') ?: '';

$API_URL = 'https://recargapro.gt.tc/api_recargas_x7k2.php';
$API_KEY = '87443981';

$STATE_FILE = __DIR__ . '/bot_state.txt';
$LOG_FILE   = __DIR__ . '/bot_log.txt';

$STATUS_OK = ['pendente', 'andamento', 'feita'];

// ---------- Modo ----------
$isCli = (PHP_SAPI === 'cli');

if (!$isCli) {
    if ($SECRET === '' || ($_GET['secret'] ?? '') !== $SECRET) {
        http_response_code(403);
        exit('403 — Forbidden');
    }
    header('Content-Type: text/plain; charset=utf-8');
}

// ---------- Helpers ----------
function log_line($msg) {
    global $LOG_FILE;
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg . PHP_EOL;
    echo $line;
    @file_put_contents($LOG_FILE, $line, FILE_APPEND);
}

function http_get($url, $headers = []) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_FOLLOWLOCATION => true,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['body' => (string)$body, 'code' => $code];
}

function send_telegram($token, $chat_id, $text) {
    $ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => http_build_query([
            'chat_id'    => $chat_id,
            'text'       => $text,
            'parse_mode' => 'HTML',
        ]),
        CURLOPT_TIMEOUT        => 20,
    ]);
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode((string)$body, true);
}

function format_order($o) {
    $emoji = ['pendente'=>'⏳','andamento'=>'🔄','feita'=>'✅'][$o['status']] ?? '📦';
    $nome = htmlspecialchars($o['revendedor']['nome'] ?? 'N/A', ENT_QUOTES, 'UTF-8');
    $mail = htmlspecialchars($o['revendedor']['email'] ?? 'N/A', ENT_QUOTES, 'UTF-8');
    $tel  = htmlspecialchars($o['telefone_formatado'] ?? $o['telefone'], ENT_QUOTES, 'UTF-8');
    $op   = strtoupper(htmlspecialchars($o['operadora'], ENT_QUOTES, 'UTF-8'));
    $val  = number_format((float)$o['valor'], 2, ',', '.');
    $cus  = number_format((float)$o['custo'], 2, ',', '.');
    $luc  = number_format((float)$o['valor'] - (float)$o['custo'], 2, ',', '.');
    $dt   = date('d/m/Y H:i', strtotime($o['criado_em'] . ' +4 hours'));

    return "{$emoji} <b>Novo Pedido #{$o['id']}</b>\n\n"
         . "👤 <b>Revendedor:</b> {$nome}\n"
         . "📧 <b>Email:</b> {$mail}\n"
         . "📱 <b>Telefone:</b> {$tel}\n"
         . "📡 <b>Operadora:</b> {$op}\n\n"
         . "💰 <b>Valor:</b> R$ {$val}\n"
         . "💸 <b>Custo:</b> R$ {$cus}\n"
         . "📈 <b>Lucro:</b> R$ {$luc}\n\n"
         . "📊 <b>Status:</b> " . ucfirst($o['status']) . "\n"
         . "🕐 <b>Data:</b> {$dt}";
}

// ---------- Execução ----------
log_line('=== Verificando novos pedidos ===');

if ($BOT_TOKEN === '') {
    log_line('ERRO: BOT_TOKEN não configurado');
    exit(1);
}
if (empty($CHAT_IDS)) {
    log_line('ERRO: CHAT_IDS não configurado');
    exit(1);
}

$r = http_get($API_URL . '?limit=100&order=desc', [
    'Authorization: Bearer ' . $API_KEY,
    'Accept: application/json',
]);

if ($r['code'] !== 200) {
    log_line("ERRO HTTP {$r['code']}: " . substr($r['body'], 0, 200));
    exit(1);
}

$json = json_decode($r['body'], true);
if (empty($json['success'])) {
    log_line('ERRO: resposta inválida da API');
    log_line(substr($r['body'], 0, 300));
    exit(1);
}

$pedidos = $json['data'] ?? [];
if (empty($pedidos)) {
    log_line('Nenhum pedido na API');
    exit(0);
}

$maxId = 0;
foreach ($pedidos as $p) {
    if ((int)$p['id'] > $maxId) $maxId = (int)$p['id'];
}
log_line('Pedidos na API: ' . count($pedidos) . " | Maior ID: {$maxId}");

$lastId = null;
if (is_file($STATE_FILE)) {
    $v = trim((string)@file_get_contents($STATE_FILE));
    if ($v !== '') $lastId = (int)$v;
}

if ($lastId === null) {
    @file_put_contents($STATE_FILE, (string)$maxId);
    log_line("Primeira execução: maxId={$maxId} salvo. Não notifica nada.");
    exit(0);
}

$novos = [];
foreach ($pedidos as $p) {
    if ((int)$p['id'] > $lastId && in_array($p['status'], $STATUS_OK, true)) {
        $novos[] = $p;
    }
}
usort($novos, fn($a, $b) => (int)$a['id'] <=> (int)$b['id']);
log_line("Último ID visto: {$lastId} | Novos: " . count($novos));

if (empty($novos)) {
    log_line('Nada a notificar.');
    exit(0);
}

foreach ($novos as $p) {
    $msg = format_order($p);
    $todosOk = true;

    foreach ($CHAT_IDS as $chatId) {
        $resp = send_telegram($BOT_TOKEN, $chatId, $msg);
        if (!($resp['ok'] ?? false)) {
            log_line("ERRO ao enviar #{$p['id']} para {$chatId}: " . substr(json_encode($resp), 0, 200));
            $todosOk = false;
        } else {
            log_line("✓ Pedido #{$p['id']} enviado para {$chatId}");
        }
        usleep(300000);
    }

    if ($todosOk) {
        @file_put_contents($STATE_FILE, (string)$p['id']);
    }
}

log_line('=== Concluído ===');
