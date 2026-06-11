// ========================================
// 大真エンジニアリング Trello 朝の通知スクリプト
// ========================================
// 平日 朝8:30 JST に自動実行され、未対応コメントを通知ハブカードに投稿します。

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const NOTIFICATION_CARD_ID = process.env.NOTIFICATION_CARD_ID;
const DASHBOARD_URL = process.env.DASHBOARD_URL || '';

// 対象ワークスペース（部分一致）
const TARGET_WORKSPACES = ['業務管理', '協力企業'];

// 通知閾値（時間単位）
const URGENT_THRESHOLD_DAYS = 3;    // 3日超 = 緊急
const WARNING_THRESHOLD_DAYS = 1;   // 1日超 = 注意

const BASE = 'https://api.trello.com/1';
const AUTH = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

// ========== ユーティリティ ==========

async function trelloFetch(path, params = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const q = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${sep}${AUTH}${q ? '&' + q : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function postComment(cardId, text) {
  const url = `${BASE}/cards/${cardId}/actions/comments?${AUTH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`コメント投稿失敗 ${res.status}: ${errText.substring(0, 200)}`);
  }
  return res.json();
}

function getElapsedDays(isoDate) {
  return (Date.now() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000);
}

function formatJstDate() {
  const now = new Date();
  // JST に変換
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const dow = ['日', '月', '火', '水', '木', '金', '土'][jst.getUTCDay()];
  return `${y}/${m}/${d} (${dow})`;
}

function truncate(text, maxLen = 60) {
  if (!text) return '';
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

// ========== メイン処理 ==========

async function main() {
  console.log('🚀 Trello朝の通知ジョブ開始');

  // 環境変数チェック
  if (!TRELLO_API_KEY || !TRELLO_TOKEN || !NOTIFICATION_CARD_ID) {
    throw new Error('環境変数 TRELLO_API_KEY, TRELLO_TOKEN, NOTIFICATION_CARD_ID が必要です');
  }

  // Step 1: 自分の情報取得
  const me = await trelloFetch('/members/me', { fields: 'id,username,fullName' });
  console.log(`👤 実行アカウント: ${me.fullName} (@${me.username})`);

  // Step 2: 対象ワークスペース取得
  const orgs = await trelloFetch('/members/me/organizations', { fields: 'id,displayName,name' });
  const targetOrgs = orgs.filter(o =>
    TARGET_WORKSPACES.some(t =>
      (o.displayName && o.displayName.includes(t)) ||
      (o.name && o.name.includes(t))
    )
  );
  console.log(`🏢 対象ワークスペース: ${targetOrgs.length}件 (${targetOrgs.map(o => o.displayName).join(', ')})`);

  if (targetOrgs.length === 0) {
    throw new Error('対象ワークスペースが見つかりません');
  }

  // Step 3: 全ボード取得
  const allBoards = [];
  for (const org of targetOrgs) {
    const boards = await trelloFetch(`/organizations/${org.id}/boards`, { fields: 'id,name,closed' });
    boards.filter(b => !b.closed).forEach(b => {
      b.workspaceName = org.displayName;
      allBoards.push(b);
    });
  }
  console.log(`📋 対象ボード: ${allBoards.length}件`);

  // Step 4: 過去7日のコメントを全ボードから取得
  const sevenDaysAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const allComments = [];

  for (const board of allBoards) {
    try {
      const actions = await trelloFetch(`/boards/${board.id}/actions`, {
        filter: 'commentCard',
        since: sevenDaysAgoISO,
        limit: 100,
      });
      actions.forEach(a => {
        a.boardName = board.name;
        a.workspaceName = board.workspaceName;
        allComments.push(a);
      });
    } catch (e) {
      console.error(`⚠️ ボード「${board.name}」取得失敗: ${e.message}`);
    }
  }
  console.log(`💬 取得コメント: ${allComments.length}件`);

  // Step 5: カードごとにコメントを集約し、未返信コメントを検出
  const byCard = {};
  for (const c of allComments) {
    const cardId = c.data?.card?.id;
    if (!cardId) continue;
    if (!byCard[cardId]) byCard[cardId] = [];
    byCard[cardId].push(c);
  }

  const unresponded = [];
  for (const cardId of Object.keys(byCard)) {
    const comments = byCard[cardId].sort((a, b) => new Date(a.date) - new Date(b.date));

    // 自分の最後のコメント日時を取得
    let lastMyCommentDate = null;
    for (const c of comments) {
      if (c.idMemberCreator === me.id) {
        lastMyCommentDate = new Date(c.date);
      }
    }

    // 他人のコメントで、自分の最後のコメントより新しいものが未返信
    for (const c of comments) {
      if (c.idMemberCreator === me.id) continue;
      if (lastMyCommentDate && new Date(c.date) <= lastMyCommentDate) continue;

      // 絵文字リアクションがあれば対応済みとみなす
      if (c.reactions && c.reactions.length > 0) continue;

      const elapsedDays = getElapsedDays(c.date);

      // 24時間未満（通常）は通知対象外
      if (elapsedDays < WARNING_THRESHOLD_DAYS) continue;

      unresponded.push({
        comment: c,
        elapsedDays,
        urgency: elapsedDays >= URGENT_THRESHOLD_DAYS ? 'urgent' : 'warning',
      });
    }
  }
  console.log(`⚠️ 未返信コメント: ${unresponded.length}件`);

  // Step 6: 緊急度別に集計
  const urgent = unresponded
    .filter(u => u.urgency === 'urgent')
    .sort((a, b) => b.elapsedDays - a.elapsedDays);
  const warning = unresponded
    .filter(u => u.urgency === 'warning')
    .sort((a, b) => b.elapsedDays - a.elapsedDays);

  console.log(`  🚨 緊急: ${urgent.length}件 / ⚠️ 注意: ${warning.length}件`);

  // Step 7: 通知メッセージを組み立て
  const dateStr = formatJstDate();
  let msg = `🤖 Claude AI より\n\n`;
  msg += `📅 ${dateStr} 朝のTrelloチェック\n\n`;

  // 緊急セクション
  msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🚨 緊急（${URGENT_THRESHOLD_DAYS}日超）: ${urgent.length}件\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (urgent.length > 0) {
    for (const u of urgent.slice(0, 15)) {
      const c = u.comment;
      const days = Math.floor(u.elapsedDays);
      const cardName = c.data?.card?.name || '(カード名取得失敗)';
      const author = c.memberCreator?.fullName || c.memberCreator?.username || 'Unknown';
      const text = truncate(c.data?.text, 60);
      const boardName = c.boardName || '';
      msg += `\n• [${boardName}] ${cardName}\n`;
      msg += `  💬 ${author}「${text}」(${days}日経過)\n`;
    }
    if (urgent.length > 15) {
      msg += `\n... 他 ${urgent.length - 15}件\n`;
    }
  } else {
    msg += `\n（緊急対応はありません）\n`;
  }

  // 注意セクション
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⚠️ 注意（${WARNING_THRESHOLD_DAYS}〜${URGENT_THRESHOLD_DAYS}日）: ${warning.length}件\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (warning.length > 0) {
    for (const w of warning.slice(0, 15)) {
      const c = w.comment;
      const days = Math.floor(w.elapsedDays);
      const cardName = c.data?.card?.name || '(カード名取得失敗)';
      const author = c.memberCreator?.fullName || c.memberCreator?.username || 'Unknown';
      const text = truncate(c.data?.text, 60);
      const boardName = c.boardName || '';
      msg += `\n• [${boardName}] ${cardName}\n`;
      msg += `  💬 ${author}「${text}」(${days}日経過)\n`;
    }
    if (warning.length > 15) {
      msg += `\n... 他 ${warning.length - 15}件\n`;
    }
  } else {
    msg += `\n（注意レベルの未対応はありません）\n`;
  }

  // フッター
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (DASHBOARD_URL) {
    msg += `\n▶ ダッシュボードで詳細確認:\n${DASHBOARD_URL}\n`;
  }
  msg += `\n📌 対応済の場合はこのコメントに👍リアクションをお願いします。\n`;
  msg += `💡 コメント返信や絵文字リアクションがあれば次回からは通知対象外になります。\n`;

  // Step 8: 通知が必要か判定
  if (urgent.length === 0 && warning.length === 0) {
    console.log('✅ 未対応案件なし。通知スキップ。');
    // 全部クリーンの日もポジティブ通知したい場合は以下のコメントを外す
    // const cleanMsg = `🤖 Claude AI より\n\n📅 ${dateStr} 朝のTrelloチェック\n\n✨ 未対応コメントはありません！\n素晴らしい！今日も良い1日を 🌅`;
    // await postComment(NOTIFICATION_CARD_ID, cleanMsg);
    return;
  }

  // Step 9: 通知投稿
  console.log('📤 通知ハブカードにコメント投稿中...');
  console.log('--- 投稿内容プレビュー ---');
  console.log(msg);
  console.log('---');

  await postComment(NOTIFICATION_CARD_ID, msg);
  console.log('✅ 通知完了');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});