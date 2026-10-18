<?php
header('Content-Type: text/plain; charset=utf-8');

$token = getenv('BOT_TOKEN') ?: '';
if ($token === '') {
    exit("Configure a env BOT_TOKEN no Render primeiro.\n");
}

$ch = curl_init("https://api.telegram.org/bot{$token}/getUpdates?limit=20");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 15,
]);
$r = curl_exec($ch);
curl_close($ch);
$data = json_decode((string)$r, true);

if (!($data['ok'] ?? false)) {
    exit("Erro Telegram:\n$r\n");
}

if (empty($data['result'])) {
    exit(
        "Nenhuma mensagem recebida ainda.\n\n" .
        "1. Abra o Telegram\n" .
        "2. Procure seu bot\n" .
        "3. Envie /start\n" .
        "4. Recarregue esta página\n"
    );
}

echo "=== CHAT IDs ENCONTRADOS ===\n\n";
$seen = [];
foreach ($data['result'] as $u) {
    $m = $u['message'] ?? $u['channel_post'] ?? null;
    if (!$m) continue;
    $id = $m['chat']['id'] ?? null;
    if ($id === null || isset($seen[$id])) continue;
    $seen[$id] = 1;

    echo "Chat ID: {$id}\n";
    echo "Tipo:    " . ($m['chat']['type'] ?? '?') . "\n";
    echo "Nome:    " . ($m['chat']['first_name'] ?? $m['chat']['title'] ?? '') . "\n";
    echo "-----------------------------------\n";
}
