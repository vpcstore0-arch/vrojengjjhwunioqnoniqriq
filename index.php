<?php
// Health check para o Render não derrubar o serviço
http_response_code(200);
header('Content-Type: text/plain; charset=utf-8');
echo "RecargaPro Bot — OK\n";
echo "Time: " . date('Y-m-d H:i:s') . "\n";
