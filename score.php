<?php
header('Content-Type: text/plain; charset=UTF-8');

// 解析する前に、届いた生のデータをそのまま保存して中身を確認してみる
$raw_data = file_get_contents('php://input');
file_put_contents(__DIR__ . '/raw_dump.txt', file_get_contents('php://input'));

// 2. URLエンコード形式を解析して $_POST にマッピング
parse_str($raw_data, $parsed);

// "name" の中身を "SongName" として扱う
if (isset($parsed['name'])) {
    $parts = explode(':', $parsed['name'], 2);
    $_POST['SongName'] = isset($parts[1]) ? $parts[1] : $parts[0];
}
// 他のデータも $_POST に入れる
if (isset($parsed['score'])) $_POST['Score'] = $parsed['score'];
if (isset($parsed['user']))  $_POST['UserName'] = $parsed['user'];

// ダウンロードユーザーデータラベル
$username = isset($_POST['UserName']) ? trim(str_replace([",", "\n", "\r"], '', (string)$_POST['UserName'])) : 'Guest';
$songname = isset($_POST['SongName']) ? trim(str_replace([",", "\n", "\r"], '', (string)$_POST['SongName'])) : 'Unknown';
$level    = isset($_POST['Level'])    ? (string)$_POST['Level'] : '-';
$score    = isset($_POST['Score'])    ? $_POST['Score'] : '0';
$flag     = isset($_POST['Flag'])     ? (string)$_POST['Flag'] : '';

// ★ 4. 日本時間の日付（時間なし）を取得
$date = date('Y-m-d');

if ($username === '') {
    exit('ERROR: Name is empty');
}
if (!is_numeric($score)) {
    exit('ERROR: Invalid score value');
}
$logLine = implode(',', [$date, $username, $songname, $level, $score, $flag,]) . "\n";

// 4. ファイルの先頭に追記（LOCK_EXで安全に）
$logFile = __DIR__ . '/debug_post.txt';
$current_logs = file_exists($logFile) ? file_get_contents($logFile) : "";
file_put_contents($logFile, $logLine . $current_logs, LOCK_EX);

// 5. 成功レスポンス
echo "SUCCESS";
?>