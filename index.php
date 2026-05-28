<?php
// --- 1. 準備：タブの判定とデータの読み込み ---
$tab = isset($_GET['tab']) ? $_GET['tab'] : 'score';
// --- 新機能：IPアドレスによるアクセスログ管理（改良版） ---
$counter_file = "access_log.txt";
$current_ip = $_SERVER['REMOTE_ADDR']; // アクセス者のIPを取得
$now = time();
$timeout = 300; // 現在のアクセスとみなす時間（5分 = 300秒）

$active_ips = [];
$total_ips = [];
?>
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>𝙎𝙩𝙚𝙡𝙡𝙖𝙉𝙚𝙩</title>
    <link rel="shortcut icon" href="./favic.ico?v=<?= time(); ?>" type="image/x-icon">
</head>
<body>

    </body>
</html>

<?php
// 1. 既存のログファイルを読み込む
if (file_exists($counter_file)) {
    $log_lines = file($counter_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($log_lines as $log_line) {
        if (strpos($log_line, ',') !== false) {
            list($time, $ip) = explode(',', $log_line);
            $time = (int)$time;
            
            // 累計用のIPリスト
            $total_ips[$ip] = true;
            
            // 5分以内のアクセスならアクティブリストに保持
            if (($now - $time) < $timeout && $time > 0) {
                $active_ips[$ip] = $time;
            }
        }
    }
}

// 2. 現在のアクセス（あなた）を最新データとして追加・更新
$active_ips[$current_ip] = $now;
$total_ips[$current_ip] = true;

// 3. 保存用データの組み立て（Online中の人と、過去の人をすべて残す）
$write_data = "";
foreach ($total_ips as $ip => $dummy) {
    if (isset($active_ips[$ip])) {
        $write_data .= $active_ips[$ip] . "," . $ip . "\n";
    } else {
        $write_data .= "0," . $ip . "\n";
    }
}

// ファイルにロックをかけて安全に保存
file_put_contents($counter_file, $write_data, LOCK_EX);

// 4. 画面に表示する人数を確定
$active_users = count($active_ips);
$total_users = count($total_ips);
?>
    <!-- 画面全体をマイクラ風にする設定 -->
   <!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    
    <!-- Googleからマイクラ風フォントを読み込むコード -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DotGothic16&display=swap" rel="stylesheet">
    <style>
        <style>
 body {
    color: #003bfd;
    background-color: rgb(255, 255, 255);
    margin: 0;
    
    /* 🌟 上のヘッダー画像と同じように背景全体に敷き詰める */
    background-image: url('backgroune.png'); 
    }
    body{
   background-image: url('https://stellastephx1.mydns.jp/backgroune.png'); 
   background-repeat: repeat;
    background-size: 1500px auto;
}

    /* --- 2. 見た目：Flexboxで全てを中央に寄せる --- */
    body {
        color: #003bfd;
        background-color: rgb(255, 255, 255);
        margin: 0;
        
        /* マイクラ風フォントとカクカク表示の設定 */
        font-family: "DotGothic16", sans-serif !important;
        image-rendering: pixelated;
        font-smooth: never;
        -webkit-font-smoothing: none;
        -moz-osx-font-smoothing: none;
        
        display: flex;
        flex-direction: column;
        align-items: center; 
        min-height: 100vh;
        box-sizing: border-box;
        padding: 20px 0;
        position: relative;
    }

body {
        /* マイクラ風フォントとカクカク表示の設定 */
        font-family: "DotGothic16", sans-serif !important;
        image-rendering: pixelated;
        font-smooth: never;
        -webkit-font-smoothing: none;
        -moz-osx-font-smoothing: none;
        
        /* 🌟ここを追加！文字を太字にする */
        font-weight: bold !important;
        
        display: flex;
        flex-direction: column;
        align-items: center; 
        min-height: 100vh;
        box-sizing: border-box;
        padding: 20px 0;
        position: relative;
    }
    .mc-italic {
        font-style: italic !important;
        display: inline-block;
    }

    /* 右上のアクセス数表示エリア */
        .counter-area {
        position: absolute;
        top: 20px;
        right: 20px;
        
        /* 🌟1. 白の透明度を上げて（70%→25%）もっと透けさせる */
        background: rgba(255, 255, 255, 0.25) !important;
        
        /* 🌟2. 後ろの背景（青色など）をぼかして「すりガラス」にする */
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
        
        /* 🌟3. ガラスの表面のような、細く白いキレイな境界線を入れる */
        border: 1px solid rgba(255, 255, 255, 0.4) !important;
        
        padding: 10px 15px;
        border-radius: 8px;
        text-align: right;
        font-weight: bold;
        
        /* 🌟4. 文字の色を、あなたがお気に入りのキレイな青（#003bfd）に統一するとさらに馴染みます */
        color: #003bfd;
        
        font-size: 14px;
        
        /* 🌟5. 影も少し柔らかい高級感のある影に変更 */
        box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
        
        z-index: 100;
    }

    .counter-item {
        margin-bottom: 5px;
    }
    .counter-item:last-child {
        margin-bottom: 0;
    }
    .counter-num {
        color: #d62020;
        font-size: 18px;
        margin-left: 5px;
    }

    #container {
        width: 100%;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
    }

    /* タブボタンのスタイル（当たり判定広め） */
    .tab-button {
        display: inline-block;
        padding: 15px 30px;
        background: #22c07e;
        color: white;
        text-decoration: none;
        border-radius: 10px;
        margin: 10px 5px;
        font-weight: bold;
    }
    .active { background: #333 !important; }

        /* ランキングの箱（中央配置） */
    .content-box {
        /* 🌟1. 白の透明度をさらに下げて（40%→20%）透明感をアップ */
        background: rgba(255, 255, 255, 0.2) !important;
        
        /* 🌟2. 超重要：後ろの青い背景をじわっとぼかして「すりガラス」にする */
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        
        /* 🌟3. ガラスの端っこが光を反射しているような、細い白い光の線を入れる */
        border: 1px solid rgba(255, 255, 255, 0.4) !important;
        
        /* 🌟4. 影に少し広がりを持たせて、ガラスがふんわり浮いている立体感を出す */
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.15) !important;

        padding: 30px;
        border-radius: 20px;
        width: 80%;
        max-width: 500px;
        text-align: center;
        box-sizing: border-box;
    }


    /* リストの中身だけは左に揃えて読みやすくする */
    ol {
        display: inline-block;
        text-align: left;
        font-size: 22px;
        margin: 0;
        padding-left: 40px;
    }
    ol li {
        margin-bottom: 10px;
    }
    
    /* スコアランキングの見出しを大きくするCSS */
    .content-box h2 {
        font-size: 36px;
        margin-top: 10px;
        margin-bottom: 20px;
    }
    </style>
</head>
<body>

<!-- 右上のアクセス表示カウンター -->
<div class="counter-area">
    <div class="counter-item">Online:<span class="counter-num"><?php echo $active_users; ?></span></div>
    <div class="counter-item">Total:<span class="counter-num"><?php echo $total_users; ?></span></div>
</div>

<div id="container">
    <img src="ty40a.png" alt="mypic" style="max-width: 90%; width: 100%; height: auto; max-width: 1582px;" />

    <div class="tab-area">
        <a href="?tab=score" class="tab-button <?php if($tab=='score') echo 'active'; ?>">Recent Scores</a>
        <a href="?tab=info" class="tab-button <?php if($tab=='info') echo 'active'; ?>">Server INFO</a>
    </div>

    <div class="content-box">
        <?php if ($tab == 'score'): ?>
            <h2><span class="mc-italic">◆-Recent Scores-◆</span></h2>
            <?php
            // 7. 保存したログを読み込んで出力するわよ！
$logFile = __DIR__. '/debug_post.txt';
if (file_exists($logFile)) {$content = file_get_contents($logFile);//ファイルの中身を一旦全部読み込む
    //特殊文字をHTMLエンティティに変換（XSS対策）
$SafeContent = htmlspecialchars($content,ENT_QUOTES,'UTF-8');

//画面表示
     echo '<pre style="text-align: left; white-space: pre-wrap; font-family: monospace;">';
     echo   $SafeContent;
            echo '</pre>'; } 
            else {echo "<p>No logs found.</p>";}
?>
        <?php else: ?>
    <h2>Server Information</h2>
    <p>𝗦𝘁𝗲𝗹𝗹𝗮 𝗦𝘁𝗲𝗽 𝗛𝗫𝟭 β𝟬.𝟭𝗮 𝗥𝗲𝗹𝗲𝗮𝘀𝗲 𝗔𝗻𝗻𝗼𝘂𝗻𝗰𝗲𝗺𝗲𝗻𝘁 📢</p>
    
    <div class="version-info" style="margin-top: 10px; font-size: 0.9em; opacity: 0.8;">
        <?php
        $versionFile = 'version_ruri.txt';
        if (file_exists($versionFile)) {
            // ファイルを読み込んで、安全にエスケープしつつ改行を反映
            echo nl2br(htmlspecialchars(file_get_contents($versionFile)));
        } else {
            echo "No version details available.";
        }
        ?>
    </div>
<?php endif; ?>
    </div>
</div>

<body>
    <html>
