// ========================================
// 大真エンジニアリング Trello 朝の通知スクリプト（多人数対応版）
// ========================================
// 平日 朝8:30 JST に自動実行され、各社員の未対応コメントを
// 各自の通知カードに投稿します。
//
// 設定: ../users.json
// テスト: TEST_MODE=true で投稿せずプレビューのみ

const fs = require('fs');
const path = require('path');

// ========== 環境変数 ==========
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const DASHBOARD_URL = process.env.DASHBOARD_URL || '';
const TEST_MODE = process.env.TEST_MODE === 'true';

// ========== 定数 ==========
const TARGET_WORKSPACES = ['業務管理', '協力企業'];
const URGENT_THRESHOLD_DAYS = 3;     // 3日超 = 緊急
const WARNING_THRESHOLD_DAYS = 1;    // 1日超 = 注意
const COMMENT_LOOKBACK_DAYS = 7;     // 過去7日分のコメントをスキャン
const MAX_ITEMS_PER_SECTION = 15;    // 1セクションあたり最大表示数
const BATCH_SIZE = 5;                // 並列API呼び出し数（レート制限考慮）

const BASE = 'https://api.trello.com/1';
const AUTH = `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;

// ========== ユーティリティ ==========

async function trelloFetch(pathStr, params = {}) {
  const sep = pathStr.includes('?') ? '&' : '?';
  const q = new URLSearchParams(params).toString();
  const url = `${BASE}${pathStr}${sep}${AUTH}${q ? '&' + q : ''}`;
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

async function processBatches(items, fn, batchSize = BATCH_SIZE) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

function buildNotificationMessage(user, urgent, warning, dateStr) {
  let msg = `🤖 Claude AI より\n\n`;
  msg += `📅 ${dateStr} 朝のTrelloチェック（${user.name} さん）\n\n`;

  // 緊急セクション
  msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🚨 緊急（${URGENT_THRESHOLD_DAYS}日超）: ${urgent.length}件\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (urgent.length > 0) {
    for (const u of urgent.slice(0, MAX_ITEMS_PER_SECTION)) {
      const c = u.comment;
      const days = Math.floor(u.elapsedDays);
      const cardName = c.data?.card?.name || '(カード名取得失敗)';
      const author = c.memberCreator?.fullName || c.memberCreator?.username || 'Unknown';
      const text = truncate(c.data?.text, 60);
      msg += `\n• [${c.boardName}] ${cardName}\n`;
      msg += `  💬 ${author}「${text}」(${days}日経過)\n`;
    }
    if (urgent.length > MAX_ITEMS_PER_SECTION) {
      msg += `\n... 他 ${urgent.length - MAX_ITEMS_PER_SECTION}件\n`;
    }
  } else {
    msg += `\n（緊急対応はありません）\n`;
  }

  // 注意セクション
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⚠️ 注意（${WARNING_THRESHOLD_DAYS}〜${URGENT_THRESHOLD_DAYS}日）: ${warning.length}件\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (warning.length > 0) {
    for (const w of warning.slice(0, MAX_ITEMS_PER_SECTION)) {
      const c = w.comment;
      const days = Math.floor(w.elapsedDays);
      const cardName = c.data?.card?.name || '(カード名取得失敗)';
      const author = c.memberCreator?.fullName || c.memberCreator?.username || 'Unknown';
      const text = truncate(c.data?.text, 60);
      msg += `\n• [${c.boardName}] ${cardName}\n`;
      msg += `  💬 ${author}「${text}」(${days}日経過)\n`;
    }
    if (warning.length > MAX_ITEMS_PER_SECTION) {
      msg += `\n... 他 ${warning.length - MAX_ITEMS_PER_SECTION}件\n`;
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

  return msg;
}

// ========== メイン処理 ==========

async function main() {
  console.log('🚀 Trello朝の通知ジョブ開始（多人数対応版）');
  if (TEST_MODE) {
    console.log('🧪 ===== TEST MODE: 投稿しません =====');
  }

  // 環境変数チェック
  if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
    throw new Error('環境変数 TRELLO_API_KEY, TRELLO_TOKEN が必要です');
  }

  // 1. users.json をロード
  const usersPath = path.join(__dirname, '..', 'users.json');
  if (!fs.existsSync(usersPath)) {
    throw new Error(`users.json が見つかりません: ${usersPath}`);
  }
  const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
  console.log(`👥 設定ユーザー数: ${users.length}名`);

  // 2. 対象ワークスペース取得
  const orgs = await trelloFetch('/members/me/organizations', {
    fields: 'id,displayName,name',
  });
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

  // 3. 全ボード取得
  const allBoards = [];
  for (const org of targetOrgs) {
    const boards = await trelloFetch(`/organizations/${org.id}/boards`, {
      fields: 'id,name,closed',
    });
    boards.filter(b => !b.closed).forEach(b => {
      b.workspaceName = org.displayName;
      allBoards.push(b);
    });
  }
  console.log(`📋 対象ボード: ${allBoards.length}件`);

  // 4. 過去7日のコメントを全ボードから一括取得
  const sevenDaysAgoISO = new Date(
    Date.now() - COMMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const allComments = [];

  for (const board of allBoards) {
    try {
      const actions = await trelloFetch(`/boards/${board.id}/actions`, {
        filter: 'commentCard',
        since: sevenDaysAgoISO,
        limit: 1000,
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
  console.log(`💬 取得コメント総数: ${allComments.length}件`);

  // 5. ユニークなカードIDを抽出
  const uniqueCardIds = [...new Set(
    allComments.map(c => c.data?.card?.id).filter(Boolean)
  )];
  console.log(`🃏 ユニークカード数: ${uniqueCardIds.length}件`);

  // 6. カードごとのメンバー情報を取得（バッチ並列）
  console.log(`🔍 カードメンバー情報を取得中...`);
  const cardMembersMap = new Map();
  await processBatches(uniqueCardIds, async (cardId) => {
    try {
      const card = await trelloFetch(`/cards/${cardId}`, { fields: 'idMembers' });
      cardMembersMap.set(cardId, card.idMembers || []);
    } catch (e) {
      cardMembersMap.set(cardId, []);
    }
  });
  console.log(`👥 カードメンバー情報取得完了`);

  // 7. カードIDごとにコメントを集約（日付順ソート）
  const commentsByCard = new Map();
  for (const c of allComments) {
    const cardId = c.data?.card?.id;
    if (!cardId) continue;
    if (!commentsByCard.has(cardId)) commentsByCard.set(cardId, []);
    commentsByCard.get(cardId).push(c);
  }
  for (const [, comments] of commentsByCard) {
    comments.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // 8. ユーザーごとに通知を作成
  const dateStr = formatJstDate();
  const summaryStats = [];

  for (const user of users) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔔 処理中: ${user.name} (@${user.trelloUsername})`);

    // このユーザーがメンバーのカードIDを抽出
    const userCardIds = [];
    for (const [cardId, memberIds] of cardMembersMap) {
      if (memberIds.includes(user.trelloMemberId)) {
        userCardIds.push(cardId);
      }
    }
    console.log(`  📋 自分がメンバーのカード: ${userCardIds.length}件`);

    // 未返信コメント検出
    const unresponded = [];
    for (const cardId of userCardIds) {
      const comments = commentsByCard.get(cardId) || [];
      if (comments.length === 0) continue;

      // このユーザーの最後のコメント日時を取得
      let lastMyCommentDate = null;
      for (const c of comments) {
        if (c.idMemberCreator === user.trelloMemberId) {
          lastMyCommentDate = new Date(c.date);
        }
      }

      // 他人のコメントで、このユーザーが返信していないものを検出
      for (const c of comments) {
        if (c.idMemberCreator === user.trelloMemberId) continue;
        if (lastMyCommentDate && new Date(c.date) <= lastMyCommentDate) continue;

        // 絵文字リアクションがあれば対応済みとみなす
        if (c.reactions && c.reactions.length > 0) continue;

        const elapsedDays = getElapsedDays(c.date);

        // 24時間未満は通知対象外
        if (elapsedDays < WARNING_THRESHOLD_DAYS) continue;

        unresponded.push({
          comment: c,
          elapsedDays,
          urgency: elapsedDays >= URGENT_THRESHOLD_DAYS ? 'urgent' : 'warning',
        });
      }
    }

    const urgent = unresponded
      .filter(u => u.urgency === 'urgent')
      .sort((a, b) => b.elapsedDays - a.elapsedDays);
    const warning = unresponded
      .filter(u => u.urgency === 'warning')
      .sort((a, b) => b.elapsedDays - a.elapsedDays);

    console.log(`  🚨 緊急: ${urgent.length}件 / ⚠️ 注意: ${warning.length}件`);
    summaryStats.push({
      user: user.name,
      urgent: urgent.length,
      warning: warning.length,
    });

    // 未対応0件ならスキップ
    if (urgent.length === 0 && warning.length === 0) {
      console.log(`  ✅ 未対応なし。通知スキップ。`);
      continue;
    }

    // メッセージ組み立て
    const msg = buildNotificationMessage(user, urgent, warning, dateStr);

    // 投稿（テストモードならプレビューのみ）
    if (TEST_MODE) {
      console.log(`  🧪 [TEST] 投稿スキップ。プレビュー:`);
      console.log(msg.split('\n').map(l => '    | ' + l).join('\n'));
    } else {
      try {
        await postComment(user.notificationCardId, msg);
        console.log(`  ✅ ${user.name} へ通知投稿完了`);
      } catch (e) {
        console.error(`  ❌ ${user.name} 投稿失敗: ${e.message}`);
      }
    }
  }

  // 9. サマリー出力
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 サマリー:');
  for (const s of summaryStats) {
    const mark = s.urgent + s.warning === 0 ? '✨' : '📌';
    console.log(`  ${mark} ${s.user}: 緊急 ${s.urgent}件 / 注意 ${s.warning}件`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(TEST_MODE ? '🧪 ✅ テスト完了（投稿なし）' : '✅ 全ユーザー処理完了');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});
