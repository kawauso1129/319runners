/* =====================================================================
   設定：FirebaseコンソールでWebアプリを追加したときに表示される
   firebaseConfig をここに貼り付けてください。
   null のままだと「デモモード」（このブラウザ内だけで動作）になります。
   ===================================================================== */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBveI3y5tgX_4o2ghK6BbiRsyoRSE-khbw",
  authDomain: "mic-runners319.firebaseapp.com",
  projectId: "mic-runners319",
  storageBucket: "mic-runners319.firebasestorage.app",
  messagingSenderId: "844241240397",
  appId: "1:844241240397:web:d54785a3d70b02d389b704",
  measurementId: "G-DLS8D7B3ML"
};

export const LOCK_SEC = 30;   // 二重押し防止：記録後、全端末でタッチを無効にする秒数
export const GRACE_SEC = 30;  // 押し忘れ判定：目安タイム＋この秒数でタッチがなければ暫定記録
export const OUTLIER = 1.5;   // 目安タイムのこの倍率を超える周に確認マーク
