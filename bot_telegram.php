<?php
/**
 * Bot Telegram — Notificador de Novos Pedidos
 * Com bypass do desafio AES de hospedagens gratuitas
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

// ---------- Logging ----------
function log_line($msg) {
    global $LOG_FILE;
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg . PHP_EOL;
    echo $line;
    @file_put_contents($LOG_FILE, $line, FILE_APPEND);
}

// ---------- HTTP com cookies e bypass do AES ----------
function http_request($url, $headers = [], $cookies = []) {
    $all_headers = $headers;

    // User-Agent de navegador real (muitas proteções ignoram curl)
    $all_headers[] = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    $all_headers[] = 'Accept: application/json, text/plain, */*';
    $all_headers[] = 'Accept-Language: pt-BR,pt;q=0.9,en;q=0.8';
    $all_headers[] = 'Accept-Encoding: identity';

    if (!empty($cookies)) {
        $parts = [];
        foreach ($cookies as $k => $v) {
            $parts[] = "{$k}={$v}";
        }
        $all_headers[] = 'Cookie: ' . implode('; ', $parts);
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 25,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_HTTPHEADER     => $all_headers,
        CURLOPT_HEADER         => true, // para capturar Set-Cookie
    ]);
    $raw = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        return ['ok' => false, 'error' => $err, 'code' => 0, 'body' => '', 'headers' => ''];
    }

    $rawHeaders = substr($raw, 0, $headerSize);
    $body       = substr($raw, $headerSize);

    // Extrai cookies que o servidor setou
    $newCookies = $cookies;
    if (preg_match_all('/^Set-Cookie:\s*([^=]+)=([^;]+)/mi', $rawHeaders, $m, PREG_SET_ORDER)) {
        foreach ($m as $row) {
            $newCookies[trim($row[1])] = trim($row[2]);
        }
    }

    return [
        'ok'      => true,
        'code'    => $httpCode,
        'body'    => $body,
        'headers' => $rawHeaders,
        'cookies' => $newCookies,
    ];
}

/**
 * Detecta se o corpo é o desafio AES da hospedagem
 */
function is_aes_challenge($body) {
    return (
        stripos($body, 'toNumbers') !== false ||
        stripos($body, 'slowAES')   !== false ||
        stripos($body, '/aes.js')   !== false ||
        stripos($body, '__test')    !== false
    );
}

/**
 * Extrai os parâmetros do desafio AES e decifra
 * Formato típico:
 *   var a = toNumbers("HEX_KEY_OU_IV");
 *   var b = toNumbers("HEX_IV_OU_KEY");
 *   var c = toNumbers("HEX_CIFRADO");
 *   document.cookie = "__test=" + toHex(slowAES.decrypt(c, 2, a, b))
 */
function solve_aes_challenge($body) {
    if (!preg_match_all('/toNumbers\s*\(\s*["\']([0-9a-fA-F]+)["\']\s*\)/', $body, $matches)) {
        return null;
    }

    $params = $matches[1];
    if (count($params) < 3) {
        return null;
    }

    // Às vezes há mais que 3; pegamos os 3 primeiros na ordem a, b, c
    $a = hex2bin($params[0]);
    $b = hex2bin($params[1]);
    $c = hex2bin($params[2]);

    if ($a === false || $b === false || $c === false) return null;
    if (strlen($a) !== 16 || strlen($b) !== 16) return null;
    if (strlen($c) === 0 || strlen($c) % 16 !== 0) return null;

    // slowAES.decrypt(c, 2, a, b) → ciphertext=c, mode=2(CBC), key=a, iv=b
    $plain = @openssl_decrypt($c, 'aes-128-cbc', $a, OPENSSL_RAW_DATA, $b);
    if ($plain === false) {
        // tenta ordem invertida (algumas hospedagens trocam key/iv)
        $plain = @openssl_decrypt($c, 'aes-128-cbc', $b, OPENSSL_RAW_DATA, $a);
    }

    if ($plain === false || $plain === '') {
        return null;
    }

    // A maioria das hospedagens espera o valor em hex
    return bin2hex($plain);
}

/**
 * Busca a API resolvendo o desafio AES se necessário
 */
function fetch_api($url, $headers = []) {
    $cookies = [];
    $maxAttempts = 4;

    for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
        $r = http_request($url, $headers, $cookies);

        if (!$r['ok']) {
            return ['ok' => false, 'error' => 'cURL: ' . $r['error']];
        }

        // Se já é JSON válido → retorna
        $j = json_decode($r['body'], true);
        if (is_array($j)) {
            return ['ok' => true, 'json' => $j, 'cookies' => $r['cookies']];
        }

        // Se é o desafio AES → resolve e tenta de novo
        if (is_aes_challenge($r['body'])) {
            log_line("  [bypass] desafio AES detectado (tentativa {$attempt})");

            // Tenta resolver o desafio
            $newCookie = solve_aes_challenge($r['body']);
            if ($newCookie !== null) {
                $cookies['__test'] = $newCookie;
                log_line("  [bypass] __test resolvido = " . substr($newCookie, 0, 20) . "...");
                continue;
            }

            // Se não decifrou, tenta pegar o cookie __test que o servidor já setou
            if (!empty($r['cookies']['__test'])) {
                $cookies = $r['cookies'];
                log_line("  [bypass] cookie __test recebido do servidor");
                continue;
            }

            log_line("  [bypass] FALHA ao resolver o desafio AES");
            log_line("  [bypass] trecho: " . substr($r['body'], 0, 200));
            return ['ok' => false, 'error' => 'Desafio AES não resolvido'];
        }

        // Resposta inesperada
        log_line("  [bypass] corpo inesperado (HTTP {$r['code']}), trecho: " . substr($r['body'], 0, 200));
        return ['ok' => false, 'error' => "Resposta não-JSON (HTTP {$r['code']})", 'body' => $r['body']];
    }

    return ['ok' => false, 'error' => 'Máximo de tentativas excedido'];
}

// ---------- Telegram ----------
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

if ($BOT_TOKEN === '') { log_line('ERRO: BOT_TOKEN não configurado'); exit(1); }
if (empty($CHAT_IDS))  { log_line('ERRO: CHAT_IDS não configurado'); exit(1); }

$api = fetch_api($API_URL . '?limit=100&order=desc', [
    'Authorization: Bearer ' . $API_KEY,
]);

if (!$api['ok']) {
    log_line('ERRO API: ' . $api['error']);
    exit(1);
}

$json = $api['json'];
if (empty($json['success'])) {
    log_line('ERRO: API respondeu success=false');
    log_line(json_encode($json));
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
