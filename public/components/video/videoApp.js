(function() {
  const ns = window.LocalMediaVideo || window.FF14SSVideo || {};
  window.LocalMediaVideo = ns;
  window.FF14SSVideo = ns;

  const formatSelectLabel = (name, type) => {
    let cleanName = name.trim();
    cleanName = cleanName
      .replace(/[\(\)\[\]（）]/g, '')
      .replace(/(screenshot|screenshots|Screenshot|Screenshots|📸|🎬|の画像|の動画)/gi, '')
      .trim();
    
    if (type === 'screenshot') {
      if (cleanName.endsWith('画像')) return cleanName;
      return `${cleanName} 画像`;
    } else {
      if (cleanName.endsWith('動画')) return cleanName;
      return `${cleanName} 動画`;
    }
  };

  ns.App = ns.App || {
  // 📁 互換性エイリアス
  get VideoApp() { return this; },
  state: {
    videos: [],
    clips: [],
    settings: null,
    sources: [],
    selectedSourceId: 'all',
    selectedVideoId: null,
    isScanning: false,
    statusFilter: 'すべて',
    fileFilter: 'すべて',
    clipState: {
      startTime: null,
      endTime: null,
      isPreviewing: false,
      isSaving: false,
      lastCreatedClip: null
    },
    thumbnailQueue: [],
    thumbnailQueuedSet: new Set(),
    thumbnailFailedSet: new Set(),
    isProcessingThumbnail: false
  },
  thumbnailObserver: null,
  thumbnailLoopId: 0,
  thumbnailSkipLogLastAt: 0,

  async init() {
    this.bindEvents();
    await this.loadSettings();
    this.renderSettings();
  },

  bindEvents() {
    // グローバルタブ切り替え（これは app.js 側でもハンドリングするが、ここでも必要な初期化を呼ぶ）
    const globalTabs = document.querySelectorAll('.global-tab');
    globalTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        const target = e.target.getAttribute('data-target');
        
        // UIの切り替え
        document.querySelectorAll('.global-tab').forEach(t => {
          t.classList.remove('active');
          t.style.fontWeight = 'normal';
          t.style.borderBottom = 'none';
          t.style.color = 'var(--subtext)';
        });
        e.target.classList.add('active');
        e.target.style.fontWeight = 'bold';
        e.target.style.borderBottom = '2px solid var(--accent)';
        e.target.style.color = 'var(--text)';
        
        document.querySelectorAll('.sidebar__nav').forEach(nav => nav.classList.add('hidden'));
        const targetNav = document.getElementById(`sidebar-nav-${target}`);
        if (targetNav) targetNav.classList.remove('hidden');

        document.getElementById('gallery-section')?.classList.add('hidden');
        document.getElementById('video-section')?.classList.add('hidden');
        document.getElementById('settings-section')?.classList.add('hidden');
        document.getElementById('clip-section')?.classList.add('hidden');
        document.getElementById('trash-section')?.classList.add('hidden');
        const backupSection = document.getElementById('backup-section');
        if (backupSection) backupSection.classList.add('hidden');

        // タブ切り替え時のクリア
        const videoPlayer = document.getElementById('video-player');
        if (videoPlayer && !videoPlayer.paused) {
          videoPlayer.pause();
        }
        const clipPlayer = document.getElementById('clip-player');
        if (clipPlayer && !clipPlayer.paused) {
          clipPlayer.pause();
        }
        const clipDirPlayer = document.getElementById('clip-dir-player');
        if (clipDirPlayer && !clipDirPlayer.paused) {
          clipDirPlayer.pause();
        }

        if (target !== 'gallery') {
          // 動画以外のタブでは、不要なUIを隠す
          document.getElementById('topbar')?.classList.add('hidden');
          document.getElementById('bulk-bar')?.classList.add('hidden');
          document.getElementById('preview-panel')?.classList.add('hidden');
          document.getElementById('resizer-right')?.classList.add('hidden');
        }

        // 動画タブ以外に移動した場合はサムネイル監視を停止してキューをクリア
        if (target !== 'video') {
          this.disconnectThumbnailObserver();
        } else {
          // 動画タブに戻った場合はリスト描画後に監視を再開
          setTimeout(() => this.observeVisibleVideoRows(), 100);
        }

        if (target === 'gallery') {
          const mainGallery = document.getElementById('gallery-section');
          if (mainGallery) mainGallery.classList.remove('hidden');
          const sidebarMain = document.querySelector('.sidebar__nav:not(.hidden)');
          if (sidebarMain) sidebarMain.classList.add('hidden');
          document.querySelectorAll('.sidebar__nav')[0]?.classList.remove('hidden');
        } else if (target === 'video') {
          const videoSec = document.getElementById('video-section');
          if (videoSec) videoSec.classList.remove('hidden');
          const sidebarVideo = document.getElementById('sidebar-nav-video');
          if (sidebarVideo) sidebarVideo.classList.remove('hidden');
          this.loadVideos();
        } else if (target === 'settings') {
          const settingsSec = document.getElementById('settings-section');
          if (settingsSec) settingsSec.classList.remove('hidden');
          const sidebarSettings = document.getElementById('sidebar-nav-settings');
          if (sidebarSettings) sidebarSettings.classList.remove('hidden');
          
          if (ns && ns.SettingsApp) {
            ns.SettingsApp.init();
          }
        } else if (target === 'clip') {
          const clipSec = document.getElementById('clip-section');
          if (clipSec) clipSec.classList.remove('hidden');
          const sidebarClip = document.getElementById('sidebar-nav-clip');
          if (sidebarClip) sidebarClip.classList.remove('hidden');
          
          if (ns && ns.ClipApp) {
            ns.ClipApp.init();
          } else {
            console.error("ClipApp is not registered on LocalMediaVideo namespace.");
          }
        } else if (target === 'trash') {
          const trashSec = document.getElementById('trash-section');
          if (trashSec) trashSec.classList.remove('hidden');
          const sidebarTrash = document.getElementById('sidebar-nav-trash');
          if (sidebarTrash) sidebarTrash.classList.remove('hidden');
          
          if (ns && ns.TrashApp) {
            ns.TrashApp.init();
          } else {
            console.error("TrashApp is not registered on LocalMediaVideo namespace.");
          }
        }
      });
    });
  },

  async loadSettings() {
    try {
      const res = await fetch('/api/video/settings');
      if (res.ok) {
        this.state.settings = await res.json();
      }
    } catch (err) {
      console.error("Failed to load settings", err);
    }
  },

  async saveSettings(settings) {
    try {
      const res = await fetch('/api/video/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        this.state.settings = { ...this.state.settings, ...settings };
        alert('設定を保存しました');
      }
    } catch (err) {
      console.error("Failed to save settings", err);
      alert('設定の保存に失敗しました');
    }
  },

  async renderSettings() {
    const root = document.getElementById('settings-app-root');
    if (!root) return;

    const s = this.state.settings || {};
    
    // 全メディアソース（アーカイブ含む）を取得
    let sources = [];
    try {
      const res = await fetch('/api/sources?include_archived=true');
      if (res.ok) sources = await res.json();
    } catch (err) {
      console.error("Failed to load sources", err);
    }

    const activeSources = sources.filter(src => src.archived === 0);
    const archivedSources = sources.filter(src => src.archived === 1);

    const escHtml = (str) => {
      if (!str) return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    root.innerHTML = `
      <h2 style="margin-bottom: 24px; color: var(--text);">アプリ設定</h2>

      <!-- 1. メディアソース（ディレクトリ）管理セクション -->
      <div class="combat-card" style="max-width: 800px; margin-bottom: 24px;">
        <h3 class="combat-card__title">📁 登録メディアソース（ディレクトリ）一覧</h3>
        
        <div style="margin-bottom: 12px; padding: 12px; background: rgba(122,162,247,0.05); border-left: 3px solid var(--accent); font-size: 12px; color: var(--subtext); line-height: 1.6; border-radius: 0 4px 4px 0;">
          <strong>💡 メディアソースの編集について</strong><br>
          ・登録済みメディアソースは<strong>表示名（のみ）</strong>変更が可能です。<br>
          ・安全設計（データ不整合防止）のため、<strong>ディレクトリパスおよび種別の直接編集は行えません。</strong><br>
          ・パスや種別を変更したい場合は、対象ソースを「登録解除」したあと、新しいディレクトリとして新規追加してください。<br>
          ・追加したメディアソースは、画像一覧または動画一覧上部の表示対象セレクトから切り替えできます。
        </div>

        <div style="margin-bottom: 20px; overflow-x: auto;">
          <table class="source-table" style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px;">
            <thead>
              <tr style="border-bottom: 2px solid var(--border); color: var(--subtext);">
                <th style="padding: 10px;">表示名</th>
                <th style="padding: 10px;">種類</th>
                <th style="padding: 10px;">絶対パス</th>
                <th style="padding: 10px; text-align: center;">状態</th>
                <th style="padding: 10px; text-align: right;">アクション</th>
              </tr>
            </thead>
            <tbody>
              ${activeSources.length === 0 ? `
                <tr>
                  <td colspan="5" style="padding: 20px; text-align: center; color: var(--subtext);">登録済みのメディアソースはありません</td>
                </tr>
              ` : activeSources.map(src => `
                <tr style="border-bottom: 1px solid var(--border); vertical-align: middle;">
                  <td style="padding: 10px; font-weight: bold; color: var(--text);">${escHtml(src.name)}</td>
                  <td style="padding: 10px; color: var(--subtext);">${src.type === 'screenshot' ? '📸 画像' : '🎬 動画'}</td>
                  <td style="padding: 10px; font-family: monospace; color: var(--subtext);">${escHtml(src.path)}</td>
                  <td style="padding: 10px; text-align: center;">
                    <button class="btn-toggle-enabled btn ${src.enabled ? 'btn--primary' : 'btn--ghost'}" data-id="${src.id}" data-enabled="${src.enabled}" style="padding: 3px 8px; font-size: 11px;">
                      ${src.enabled ? '有効' : '無効'}
                    </button>
                  </td>
                  <td style="padding: 10px; text-align: right; white-space: nowrap;">
                    ${src.type === 'screenshot' ? `<button class="btn-scan-source btn btn--ghost" data-id="${src.id}" style="padding: 3px 8px; font-size: 11px; margin-right: 4px; color: var(--accent);">🔍 スキャン</button>` : ''}
                    <button class="btn-edit-source btn btn--ghost" data-id="${src.id}" data-name="${escHtml(src.name)}" style="padding: 3px 8px; font-size: 11px; margin-right: 4px;">
                      編集
                    </button>
                    <button class="btn-archive-source btn btn--ghost" data-id="${src.id}" style="padding: 3px 8px; font-size: 11px; color: #f7768e;">
                      登録解除
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <h4 style="margin-bottom: 12px; color: var(--text); font-size: 14px;">➕ 新しいメディアソースの追加</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 12px; background: rgba(255,255,255,0.02); padding: 16px; border-radius: 6px; border: 1px solid var(--border);">
          <div style="flex: 1; min-width: 150px;">
            <label style="display: block; margin-bottom: 6px; color: var(--subtext); font-size: 11px;">表示名</label>
            <input type="text" id="new-source-name" class="combat-input" placeholder="例: モンハン 画像" style="width: 100%;">
          </div>
          <div style="width: 120px;">
            <label style="display: block; margin-bottom: 6px; color: var(--subtext); font-size: 11px;">種類</label>
            <select id="new-source-type" class="ctrl-select" style="width: 100%; height: 34px; background: var(--card); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius-sm); padding: 0 8px; font-size: 13px; font-weight: 500; cursor: pointer; outline: none;">
              <option value="screenshot">📸 画像</option>
              <option value="video">🎬 動画</option>
            </select>
          </div>
          <div style="flex: 2; min-width: 250px;">
            <label style="display: block; margin-bottom: 6px; color: var(--subtext); font-size: 11px;">ディレクトリ絶対パス</label>
            <input type="text" id="new-source-path" class="combat-input" placeholder="例: D:\\MHW\\screenshot" style="width: 100%;">
          </div>
          <div style="align-self: flex-end;">
            <button id="btn-add-source" class="btn btn--primary" style="height: 32px; padding: 0 16px;">追加</button>
          </div>
        </div>
      </div>

      <!-- 2. アーカイブ（登録解除済み）ソースセクション -->
      ${archivedSources.length > 0 ? `
        <div class="combat-card" style="max-width: 800px; margin-bottom: 24px; border-left: 4px solid var(--subtext);">
          <h3 class="combat-card__title" style="color: var(--subtext);">📦 解除済みメディアソース（アーカイブ）</h3>
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; color: var(--subtext);">
              <thead>
                <tr style="border-bottom: 1px solid var(--border);">
                  <th style="padding: 8px;">表示名</th>
                  <th style="padding: 8px;">種類</th>
                  <th style="padding: 8px;">絶対パス</th>
                  <th style="padding: 8px; text-align: right;">アクション</th>
                </tr>
              </thead>
              <tbody>
                ${archivedSources.map(src => `
                  <tr style="border-bottom: 1px solid var(--border); vertical-align: middle;">
                    <td style="padding: 8px; font-weight: bold;">${escHtml(src.name)}</td>
                    <td style="padding: 8px;">${src.type === 'screenshot' ? '📸 画像' : '🎬 動画'}</td>
                    <td style="padding: 8px; font-family: monospace;">${escHtml(src.path)}</td>
                    <td style="padding: 8px; text-align: right;">
                      <button class="btn-restore-source btn btn--ghost" data-id="${src.id}" style="padding: 2px 6px; font-size: 11px;">
                        復元する
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

      <!-- 3. システム共通設定セクション -->
      <div class="combat-card" style="max-width: 800px;">
        <h3 class="combat-card__title">⚙️ システム共通設定</h3>
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div style="display: flex; gap: 16px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 250px;">
              <label style="display: block; margin-bottom: 8px; color: var(--subtext); font-size: 13px;">クリップ保存先ディレクトリ (絶対パス)</label>
              <input type="text" id="setting-clip-dir" class="combat-input" value="${s.clipOutputDir || ''}" placeholder="D:\\Videos\\Clips" style="width: 100%;">
            </div>
            <div style="flex: 1; min-width: 250px;">
              <label style="display: block; margin-bottom: 8px; color: var(--subtext); font-size: 13px;">軽量版保存先ディレクトリ (絶対パス)</label>
              <input type="text" id="setting-light-dir" class="combat-input" value="${s.compressedOutputDir || ''}" placeholder="D:\\Videos\\Light" style="width: 100%;">
            </div>
          </div>
          <div>
            <label style="display: block; margin-bottom: 8px; color: var(--subtext); font-size: 13px;">ffmpegパス (未設定でも可)</label>
            <input type="text" id="setting-ffmpeg-path" class="combat-input" value="${s.ffmpegPath || ''}" placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe" style="width: 100%;">
          </div>
          <div style="margin-top: 4px; padding: 12px; background: rgba(255,193,7,0.05); border-left: 3px solid #ffc107; font-size: 12px; color: var(--subtext); line-height: 1.5; border-radius: 0 4px 4px 0;">
            <strong>💡 安全設計ポリシー（完全読み取り専用）</strong><br>
            本アプリからメディアや動画の実ファイルを物理削除・リネームすることはありません。<br>
            不要になった実ファイルは、エクスプローラー等で手動で削除してください。
          </div>
          <div style="margin-top: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; color: var(--subtext); font-size: 13px; cursor: pointer;">
              <input type="checkbox" id="setting-auto-thumb" ${s.autoThumbnailGeneration === true ? 'checked' : ''}>
              動画サムネイル自動生成 (動画タブ表示中のみ)
            </label>
          </div>
          <div style="margin-top: 16px;">
            <button id="btn-save-settings" class="btn btn--primary">共通設定を保存</button>
          </div>
        </div>
      </div>
    `;

    // ===== イベントリスナーのバインド =====
    
    // 共通設定保存
    document.getElementById('btn-save-settings').addEventListener('click', () => {
      this.saveSettings({
        clipOutputDir: document.getElementById('setting-clip-dir').value.trim(),
        compressedOutputDir: document.getElementById('setting-light-dir').value.trim(),
        ffmpegPath: document.getElementById('setting-ffmpeg-path').value.trim(),
        deleteMode: this.state.settings.deleteMode || 'trash',
        autoThumbnailGeneration: document.getElementById('setting-auto-thumb').checked
      });
    });

    // 画像ソース スキャン
    document.querySelectorAll('.btn-scan-source').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sourceId = parseInt(btn.dataset.id);
        btn.disabled = true;
        btn.textContent = 'スキャン中...';
        try {
          const res = await fetch('/api/rescan/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceId })
          });
          if (!res.ok) {
            const err = await res.json();
            alert(`スキャン開始失敗: ${err.error}`);
            return;
          }
          const { jobId } = await res.json();
          const es = new EventSource(`/api/rescan/events/${jobId}`);
          es.addEventListener('finished', async (e) => {
            es.close();
            const d = JSON.parse(e.data);
            alert(`スキャン完了: 新規 ${d.added}件, 更新 ${d.updated}件`);
            if (window.loadSidebarData) window.loadSidebarData();
          });
          es.addEventListener('error', (e) => {
            es.close();
            const msg = e.data ? JSON.parse(e.data)?.message : 'スキャンエラー';
            alert(`エラー: ${msg}`);
          });
          es.addEventListener('log', () => {}); // ログは無視
        } catch (err) {
          alert(`エラー: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = '🔍 スキャン';
        }
      });
    });

    // 新規ソース追加
    document.getElementById('btn-add-source').addEventListener('click', async () => {
      const name = document.getElementById('new-source-name').value.trim();
      const type = document.getElementById('new-source-type').value;
      const path = document.getElementById('new-source-path').value.trim();

      if (!name || !path) {
        alert('表示名と絶対パスを入力してください。');
        return;
      }

      try {
        const res = await fetch('/api/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, type, path })
        });
        if (res.ok) {
          alert('メディアソースを追加しました。');
          this.renderSettings(); // 再描画
          
          // サイドバー等のメディアドロップダウンも更新
          if (window.loadSidebarData) window.loadSidebarData();
        } else if (res.status === 409) {
          const err = await res.json();
          if (err.archivedSourceId) {
            const confirmRestore = confirm('既に登録解除済みの同一ソースが見つかりました。\n復元して再利用しますか？\n（復元すると、以前登録していたときのお気に入りやタグなどのデータも元通りに引き継がれます）');
            if (confirmRestore) {
              const restoreRes = await fetch(`/api/sources/${err.archivedSourceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archived: false, enabled: true })
              });
              if (restoreRes.ok) {
                alert('メディアソースを正常に復元しました！');
                this.renderSettings();
                if (window.loadSidebarData) window.loadSidebarData();
              } else {
                const restoreErr = await restoreRes.json();
                alert(`復元に失敗しました: ${restoreErr.error}`);
              }
            }
          } else {
            alert(`追加失敗: ${err.error}`);
          }
        } else {
          const err = await res.json();
          alert(`追加失敗: ${err.error}`);
        }
      } catch (err) {
        alert(`エラー: ${err.message}`);
      }
    });

    // 表示名編集
    document.querySelectorAll('.btn-edit-source').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const currentName = btn.dataset.name;
        const newName = prompt('表示名のみ変更可能です。新しい表示名を入力してください：', currentName);
        if (newName === null) return; // キャンセル
        const trimmed = newName.trim();
        if (!trimmed) {
          alert('表示名は空欄にできません。');
          return;
        }

        try {
          const res = await fetch(`/api/sources/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed })
          });
          if (res.ok) {
            alert('表示名を更新しました。');
            this.renderSettings();
            if (window.loadSidebarData) window.loadSidebarData();
          } else {
            const err = await res.json();
            alert(`更新失敗: ${err.error}`);
          }
        } catch (err) {
          alert(`エラー: ${err.message}`);
        }
      });
    });

    // 有効・無効トグル
    document.querySelectorAll('.btn-toggle-enabled').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const currentEnabled = btn.dataset.enabled === '1';
        try {
          const res = await fetch(`/api/sources/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !currentEnabled })
          });
          if (res.ok) {
            this.renderSettings();
            if (window.loadSidebarData) window.loadSidebarData();
          }
        } catch (err) {
          alert(`更新失敗: ${err.message}`);
        }
      });
    });

    // 登録解除（アーカイブ）
    document.querySelectorAll('.btn-archive-source').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const confirmMsg = "このメディアソースの登録を解除（アーカイブ化）しますか？\n\n🔒 安全設計：\n実フォルダ内のメディアファイル、および登録時のお気に入り・タグ・メモなどのメタデータは一切物理削除されません。設定画面からいつでも元通りに「復元」可能です。";
        if (!confirm(confirmMsg)) return;

        try {
          const res = await fetch(`/api/sources/${id}`, {
            method: 'DELETE'
          });
          if (res.ok) {
            alert('登録を解除しました（アーカイブ化完了）。');
            this.renderSettings();
            if (window.loadSidebarData) window.loadSidebarData();
          }
        } catch (err) {
          alert(`解除失敗: ${err.message}`);
        }
      });
    });

    // 復元（アーカイブ解除）
    document.querySelectorAll('.btn-restore-source').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          const res = await fetch(`/api/sources/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: false, enabled: true })
          });
          if (res.ok) {
            alert('メディアソースを正常に復元しました！');
            this.renderSettings();
            if (window.loadSidebarData) window.loadSidebarData();
          }
        } catch (err) {
          alert(`復元失敗: ${err.message}`);
        }
      });
    });
  },

  async loadVideos() {
    try {
      // 1. メディアソース一覧も取得する
      const sourcesRes = await fetch('/api/sources');
      if (sourcesRes.ok) {
        this.state.sources = await sourcesRes.json();
      }

      // 現在の動画ソースフィルタ値（初期値は state.selectedSourceId または DOM から取得）
      const videoSourceSelect = document.getElementById('video-source-filter-select');
      const sourceId = videoSourceSelect ? videoSourceSelect.value : this.state.selectedSourceId;
      this.state.selectedSourceId = sourceId;

      const res = await fetch(`/api/video/list?source_id=${sourceId}`);
      const data = await res.json();
      this.state.videos = data;
      
      const clipsRes = await fetch('/api/video/clips');
      const clipsData = await clipsRes.json();
      this.state.clips = clipsData;
      
      this.renderVideoList();
    } catch (err) {
      console.error("Failed to load videos", err);
    }

    // バックグラウンドでスキャンを実行し、更新があれば再描画
    if (!this.state.isScanning) {
      this.state.isScanning = true;
      this.renderVideoList(); // Scanning表示のため
      try {
        const sourceId = this.state.selectedSourceId;
        
        const scanRes = await fetch('/api/video/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: sourceId !== 'all' ? parseInt(sourceId) : null })
        });
        if (scanRes.ok) {
          const scanData = await scanRes.json();
          if (scanData.added > 0) {
            const listRes = await fetch(`/api/video/list?source_id=${sourceId}`);
            if (listRes.ok) {
              this.state.videos = await listRes.json();
            }
          }
        }
      } catch (err) {
        console.error("Failed to scan videos", err);
      } finally {
        this.state.isScanning = false;
        this.renderVideoList();
      }
    }
  },

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  },

  renderVideoList() {
    const root = document.getElementById('video-app-root');
    if (!root) return;

    const videos = this.state.videos || [];
    const activeVideoSources = (this.state.sources || []).filter(src => src.enabled === 1 && src.archived === 0 && src.type === 'video');
    
    // 容量と件数の計算
    const totalSize = videos.reduce((acc, v) => acc + (v.size || 0), 0);
    const trashVideos = videos.filter(v => v.status === '削除候補');
    const trashSize = trashVideos.reduce((acc, v) => acc + (v.size || 0), 0);
    
    // フィルタ適用
    let filtered = videos;
    if (this.state.statusFilter !== 'すべて') {
      filtered = videos.filter(v => (v.status || '未確認') === this.state.statusFilter);
    }
    if (this.state.fileFilter === 'ファイルあり') {
      filtered = filtered.filter(v => v.fileExists !== false);
    } else if (this.state.fileFilter === 'ファイル未検出') {
      filtered = filtered.filter(v => v.fileExists === false);
    }
    const filteredSize = filtered.reduce((acc, v) => acc + (v.size || 0), 0);

    // UIを分割：左に動画リスト、右にプレビュー（選択時のみ表示）
    // CSS resizeを使って可変にする
    // スクロール位置の維持
    const listContainer = document.getElementById('video-list-scroll-container');
    const currentScrollTop = listContainer ? listContainer.scrollTop : 0;

    let html = `
      <div style="display: flex; height: 100%; gap: 16px;">
        <div style="flex: 0 0 auto; width: 350px; min-width: 250px; max-width: 50vw; resize: horizontal; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;">
          <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-dark);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <h3 style="margin: 0; font-size: 15px; color: var(--text);">動画一覧</h3>
              ${this.state.isScanning ? '<span style="color: var(--accent); font-size: 12px;">🔄 スキャン中...</span>' : ''}
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px; color: var(--subtext); background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px;">
              <div>全体: <span style="color: var(--text);">${videos.length}件 / ${this.formatBytes(totalSize)}</span></div>
              <div>表示: <span style="color: var(--text);">${filtered.length}件 / ${this.formatBytes(filteredSize)}</span></div>
              <div style="grid-column: 1 / span 2; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.1);">
                <span style="color: #f44336;">削除見込み: ${trashVideos.length}件 / ${this.formatBytes(trashSize)}</span>
              </div>
            </div>
          </div>
          <div style="padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--sidebar); display: flex; gap: 8px; flex-direction: column;">
            <select id="video-source-filter-select" class="ctrl-select" style="width: 100%; height: 34px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 4px; outline: none; cursor: pointer;">
              <option value="all" ${this.state.selectedSourceId === 'all' ? 'selected' : ''}>すべての動画</option>
              ${activeVideoSources.map(src => {
                const label = formatSelectLabel(src.name, 'video');
                return `<option value="${src.id}" ${this.state.selectedSourceId == src.id ? 'selected' : ''} title="${escHtml(src.path)}">${escHtml(label)}</option>`;
              }).join('')}
            </select>
            <select id="video-status-filter" class="ctrl-select" style="width: 100%; height: 34px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 4px; outline: none; cursor: pointer;">
              <option value="すべて" ${this.state.statusFilter === 'すべて' ? 'selected' : ''}>ステータス: すべて</option>
              <option value="未確認" ${this.state.statusFilter === '未確認' ? 'selected' : ''}>未確認</option>
              <option value="残す" ${this.state.statusFilter === '残す' ? 'selected' : ''}>残す</option>
              <option value="クリップ化対象" ${this.state.statusFilter === 'クリップ化対象' ? 'selected' : ''}>クリップ化対象</option>
              <option value="クリップ作成済み" ${this.state.statusFilter === 'クリップ作成済み' ? 'selected' : ''}>クリップ作成済み</option>
              <option value="軽量化対象" ${this.state.statusFilter === '軽量化対象' ? 'selected' : ''}>軽量化対象</option>
              <option value="削除候補" ${this.state.statusFilter === '削除候補' ? 'selected' : ''}>削除候補</option>
              <option value="保留" ${this.state.statusFilter === '保留' ? 'selected' : ''}>保留</option>
              <option value="元動画保持" ${this.state.statusFilter === '元動画保持' ? 'selected' : ''}>元動画保持</option>
            </select>
            <select id="video-file-filter" class="ctrl-select" style="width: 100%; height: 34px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; cursor: pointer;">
              <option value="すべて" ${this.state.fileFilter === 'すべて' ? 'selected' : ''}>ファイル状態: すべて</option>
              <option value="ファイルあり" ${this.state.fileFilter === 'ファイルあり' ? 'selected' : ''}>ファイルあり</option>
              <option value="ファイル未検出" ${this.state.fileFilter === 'ファイル未検出' ? 'selected' : ''}>ファイル未検出</option>
            </select>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 90px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-card); font-size: 11px; color: var(--subtext); font-weight: bold;">
            <div style="padding-left: 108px;">ファイル名</div>
            <div style="text-align: right;">ステータス</div>
          </div>
          <div id="video-list-scroll-container" style="flex: 1; overflow-y: auto;">
            <div id="video-list" style="display: flex; flex-direction: column;">
    `;

    if (activeVideoSources.length === 0) {
      html += `
        <div style="text-align:center; padding: 48px 16px; color: var(--subtext);">
          <div style="font-size: 24px; margin-bottom: 12px;">🎬</div>
          <strong style="color: var(--text); display: block; margin-bottom: 8px; font-size: 14px;">動画ソースが未登録です</strong>
          <p style="font-size: 11px; margin-bottom: 16px; line-height: 1.5; color: var(--subtext);">
            動画を表示するには、まず設定画面から動画用のフォルダを追加してください。
          </p>
          <button id="btn-video-go-to-settings" class="btn btn--primary btn--sm" style="margin: 0 auto;">⚙️ 動画ソースを追加する</button>
        </div>
      `;
    } else if (videos.length === 0) {
      html += `<div style="text-align:center; padding: 32px; color: var(--subtext);">動画が見つかりません。登録したディレクトリをスキャンするか、動画ファイルが実在するか確認してください。</div>`;
    } else if (filtered.length === 0) {
      html += `<div style="text-align:center; padding: 32px; color: var(--subtext);">条件に一致する動画がありません。</div>`;
    } else {
      // 日付降順などでソート
      const sorted = [...filtered].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      
      // 全クリップを取得し、videoIdごとにカウント
      const allClips = this.state.clips || [];
      const clipCounts = {};
      allClips.forEach(c => {
        clipCounts[c.sourceVideoId] = (clipCounts[c.sourceVideoId] || 0) + 1;
      });

      sorted.forEach(v => {
        const isSelected = this.state.selectedVideoId === v.id;
        const bg = isSelected ? 'var(--bg-hover)' : 'transparent';
        const statusText = v.status || '未確認';
        const clipCount = clipCounts[v.id] || 0;
        
        let statusColor = 'var(--text)';
        if (statusText === 'クリップ作成済み') statusColor = '#4caf50';
        else if (statusText === '削除候補') statusColor = '#f44336';
        else if (statusText === '元動画保持') statusColor = '#2196f3';
        
        const thumbHtml = v.thumbnailPath
          ? `<img src="${v.thumbnailPath}" style="width: 96px; height: 54px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" />`
          : `<div class="thumb-placeholder" style="width: 96px; height: 54px; background: #333; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">🎬</div>`;

        let clipBadgeHtml = '';
        if (clipCount > 0) {
          clipBadgeHtml = `<span class="clip-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; background: rgba(76, 175, 80, 0.15); color: #4CAF50;">✅ クリップ済み ${clipCount}件</span>`;
        } else {
          clipBadgeHtml = `<span class="clip-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; background: rgba(255, 255, 255, 0.05); color: var(--subtext);">未クリップ</span>`;
        }

        const isMissing = v.fileExists === false;
        const fileBadgeHtml = isMissing
          ? `<span class="file-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; background: rgba(244, 67, 54, 0.15); color: #f44336; font-weight: bold;">❌ ファイル未検出</span>`
          : '';

        html += `
          <div class="video-list-row" data-id="${v.id}" style="display: flex; align-items: center; gap: 12px; padding: 10px 12px; min-height: 76px; border-bottom: 1px solid #222; cursor: pointer; background: ${bg}; transition: background 0.2s;">
            <div class="video-thumb-wrap" id="thumb-container-${v.id}" style="width: 96px; height: 54px; flex-shrink: 0;">
              ${thumbHtml}
            </div>
            
            <div class="video-info" style="flex: 1; min-width: 0;">
              <div class="video-list-title" style="font-weight: ${isSelected ? '600' : 'normal'}; color: var(--text); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${v.fileName}">${v.fileName}</div>
              <div class="video-meta" style="font-size: 12px; color: var(--subtext); opacity: 0.75; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; word-break: normal; overflow-wrap: normal;">
                ${this.formatBytes(v.size)} / ${this.formatDate(v.updatedAt)}
              </div>
              <div class="video-badges" style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px;">
                <span class="status-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; background: rgba(255,255,255,0.1); color: ${statusColor};">
                  ${statusText}
                </span>
                ${clipBadgeHtml}
                ${fileBadgeHtml}
              </div>
            </div>
          </div>
        `;
      });
    }

    html += `
            </div>
          </div>
        </div>
        
        <div id="video-preview-pane" style="flex: 1; display: ${this.state.selectedVideoId ? 'flex' : 'none'}; flex-direction: column; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; min-width: 400px;">
        </div>
      </div>
    `;

    root.innerHTML = html;

    // イベントバインド
    document.querySelectorAll('.video-list-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        this.selectVideo(id);
      });
    });
    
    document.getElementById('video-status-filter')?.addEventListener('change', (e) => {
      this.state.statusFilter = e.target.value;
      
      // フィルタ適用時に現在選択中の動画が条件から外れる場合は選択解除する
      if (this.state.selectedVideoId) {
        const selected = this.state.videos.find(v => v.id === this.state.selectedVideoId);
        if (selected && this.state.statusFilter !== 'すべて' && (selected.status || '未確認') !== this.state.statusFilter) {
          this.state.selectedVideoId = null;
        }
      }
      this.renderVideoList();
    });

    document.getElementById('video-file-filter')?.addEventListener('change', (e) => {
      this.state.fileFilter = e.target.value;
      
      // フィルタ適用時に現在選択中の動画が条件から外れる場合は選択解除する
      if (this.state.selectedVideoId) {
        const selected = this.state.videos.find(v => v.id === this.state.selectedVideoId);
        if (selected) {
          const isMissing = selected.fileExists === false;
          if (this.state.fileFilter === 'ファイルあり' && isMissing) {
            this.state.selectedVideoId = null;
          } else if (this.state.fileFilter === 'ファイル未検出' && !isMissing) {
            this.state.selectedVideoId = null;
          }
        }
      }
      this.renderVideoList();
    });

    document.getElementById('video-source-filter-select')?.addEventListener('change', (e) => {
      this.state.selectedSourceId = e.target.value;
      this.loadVideos();
    });

    document.getElementById('btn-video-go-to-settings')?.addEventListener('click', () => {
      document.querySelector('.global-tab[data-target="settings"]')?.click();
    });
    
    if (this.state.selectedVideoId) {
      const el = document.querySelector(`.video-list-row[data-id="${this.state.selectedVideoId}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
      this.renderPreviewPane(this.state.selectedVideoId);
    }

    // リスト描画後に可視行のサムネイル生成を開始
    this.observeVisibleVideoRows();

    // スクロール位置の復元
    const newListContainer = document.getElementById('video-list-scroll-container');
    if (newListContainer) {
      newListContainer.scrollTop = currentScrollTop;
    }
  },

  selectVideo(id) {
    if (this.state.selectedVideoId !== id) {
      this.state.clipState = { startTime: null, endTime: null, isPreviewing: false, isSaving: false, lastCreatedClip: null };
    }
    this.state.selectedVideoId = id;
    
    // 一覧の再描画を避け、DOMクラスの切り替えで対応する
    document.querySelectorAll('.video-list-row').forEach(row => {
      const isSelected = row.getAttribute('data-id') === id;
      row.style.background = isSelected ? 'var(--bg-hover)' : 'transparent';
      const titleDiv = row.querySelector('.video-list-title');
      if (titleDiv) {
        titleDiv.style.fontWeight = isSelected ? 'bold' : 'normal';
      }
    });

    this.renderPreviewPane(id);

    // サムネイル生成をキックする（失敗済み・キュー中・生成中は除外、リンク切れもスキップ）
    const video = this.state.videos.find(v => v.id === id);
    if (video && !video.thumbnailPath
        && video.fileExists !== false
        && !this.state.thumbnailFailedSet.has(id)
        && !this.state.thumbnailQueuedSet.has(id)) {
      this.generateThumbnail(id);
    }
  },

  async generateThumbnail(id) {
    const video = this.state.videos.find(v => v.id === id);
    if (video && video.fileExists === false) {
      return;
    }
    const container = document.getElementById(`thumb-container-${id}`);
    if (container) {
      if (!container.innerHTML.includes('\uD83C\uDFAC')) return;
      container.innerHTML = `<div class="thumb-placeholder" style="width: 96px; height: 54px; background: #333; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; color: #aaa;">生成中...</div>`;
    }

    try {
      const res = await fetch(`/api/video/${id}/thumbnail`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        const video = this.state.videos.find(v => v.id === id);
        if (video) video.thumbnailPath = data.thumbnailPath;
        this.updateThumbnailInList(id, data.thumbnailPath);
      } else {
        const reason = data.reason || 'unknown_error';
        const msg = data.message || data.error || '生成に失敗しました';
        if (res.status === 409 || res.status === 429 || reason === 'generating') {
          console.log(`[Thumbnail] 現在生成中のためスキップ (ID: ${id})`);
          if (container) {
            container.innerHTML = `<div class="thumb-placeholder" style="width: 96px; height: 54px; background: #333; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">🎬</div>`;
          }
        } else {
          console.warn(`[Thumbnail] 失敗 (${reason}): ${msg}`);
          this.state.thumbnailFailedSet.add(id);
          if (container) {
            container.innerHTML = `<div class="thumb-placeholder" title="${msg}" style="width: 96px; height: 54px; background: #333; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; cursor: help;">🎬<span style="position: absolute; font-size: 10px; color: #ff9800; margin-top: 30px;">!</span></div>`;
          }
        }
      }
    } catch (err) {
      console.error('[Thumbnail] 通信エラー:', err.message);
      this.state.thumbnailFailedSet.add(id);
      if (container && !container.innerHTML.includes('\uD83C\uDFAC')) {
        container.innerHTML = `<div class="thumb-placeholder" title="通信エラー" style="width: 96px; height: 54px; background: #333; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; cursor: help;">🎬<span style="position: absolute; font-size: 10px; color: #f44336; margin-top: 30px;">!</span></div>`;
      }
    }
  },

  observeVisibleVideoRows() {
    this.disconnectThumbnailObserver();

    if (!this.state.settings || this.state.settings.autoThumbnailGeneration !== true) {
      return;
    }

    // 実際にスクロールするコンテナをrootに指定する
    const scrollContainer = document.getElementById('video-list-scroll-container');
    if (!scrollContainer) return;

    this.thumbnailObserver = new IntersectionObserver((entries) => {
      let skipCount = 0;
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const videoId = entry.target.getAttribute('data-id');
          const result = this.enqueueThumbnailGeneration(videoId);
          if (result === 'skipped_limit') skipCount++;
        }
      });
      if (skipCount > 0) {
        const now = Date.now();
        if (now - this.thumbnailSkipLogLastAt > 1000) {
          console.log(`[Thumbnail] キュー上限のため ${skipCount} 件をスキップ`);
          this.thumbnailSkipLogLastAt = now;
        }
      }
    }, {
      root: scrollContainer,
      rootMargin: '0px 0px',
      threshold: 0.1
    });

    document.querySelectorAll('.video-list-row').forEach(row => {
      this.thumbnailObserver.observe(row);
    });
  },

  disconnectThumbnailObserver() {
    if (this.thumbnailObserver) {
      this.thumbnailObserver.disconnect();
      this.thumbnailObserver = null;
    }
    this.state.thumbnailQueue = [];
    this.state.thumbnailQueuedSet.clear();
  this.thumbnailLoopId++; // 古いループをキャンセル
  },

  enqueueThumbnailGeneration(videoId) {
    if (this.state.thumbnailQueuedSet.has(videoId)) return 'skipped_already_queued';
    if (this.state.thumbnailFailedSet.has(videoId)) return 'skipped_failed';

    // キューの最大数制限
    if (this.state.thumbnailQueue.length >= 5) {
      return 'skipped_limit';
    }

    const video = this.state.videos.find(v => v.id === videoId);
    if (!video || video.thumbnailPath || video.fileExists === false) return 'skipped_has_thumb_or_missing';

    const container = document.getElementById(`thumb-container-${videoId}`);
    if (container && !container.innerHTML.includes('\uD83C\uDFAC')) return 'skipped_not_placeholder';

    this.state.thumbnailQueue.push(videoId);
    this.state.thumbnailQueuedSet.add(videoId);

    if (!this.state.isProcessingThumbnail) {
      this.thumbnailLoopId++;
      this.processThumbnailQueue(this.thumbnailLoopId);
    }
    return 'enqueued';
  },

  async processThumbnailQueue(loopId) {
    // ループIDが変わっていたら終了
    if (this.thumbnailLoopId !== loopId) {
      console.log(`[Thumbnail] 古いループを安全に停止しました (Loop ID: ${loopId})`);
      return;
    }

    if (this.state.thumbnailQueue.length === 0) {
      this.state.isProcessingThumbnail = false;
      return;
    }

    this.state.isProcessingThumbnail = true;
    const videoId = this.state.thumbnailQueue.shift();

    try {
      const rowExists = document.querySelector(`.video-list-row[data-id="${videoId}"]`);
      if (rowExists) {
        await this.generateThumbnail(videoId);
      }
    } finally {
      // 処理が終わったらキュー管理Setから外す
      this.state.thumbnailQueuedSet.delete(videoId);
    }

    // 次を処理
    this.processThumbnailQueue(loopId);
  },

  updateThumbnailInList(id, path) {
    const container = document.getElementById(`thumb-container-${id}`);
    if (container) {
      container.innerHTML = `<img src="${path}" style="width: 96px; height: 54px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" />`;
    }
  },

  formatTimeMs(seconds) {
    if (seconds === null || seconds === undefined) return '--:--.---';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
  },

  renderPreviewPane(id) {
    const pane = document.getElementById('video-preview-pane');
    if (!pane) return;
    
    const video = this.state.videos.find(v => v.id === id);
    if (!video) {
      pane.style.display = 'none';
      return;
    }
    
    pane.style.display = 'flex';

    const isMissing = video.fileExists === false;

    // プレビュー表示および操作用HTMLの切り替え
    let playerHtml = '';
    let clipPanelHtml = '';

    if (isMissing) {
      playerHtml = `
        <div style="padding: 32px 24px; background: rgba(244, 67, 54, 0.05); text-align: left; width: 100%; display: flex; flex-direction: column; gap: 16px; justify-content: center; align-items: center; min-height: 300px; border-bottom: 1px solid var(--border);">
          <div style="max-width: 500px; width: 100%;">
            <h3 style="color: #f44336; margin-top: 0; display: flex; align-items: center; gap: 8px; font-size: 16px;">
              <span>❌ 実ファイルが見つかりません</span>
            </h3>
            <p style="font-size: 13px; color: var(--subtext); line-height: 1.6; margin: 8px 0;">
              ファイルが手動で移動・リネームされたか、または外付けドライブ等のストレージが一時的に接続されていない可能性があります。
            </p>
            <div style="margin-top: 12px; font-size: 12px; font-family: monospace; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 4px; border: 1px solid var(--border); word-break: break-all; color: var(--text);">
              <strong>対象パス:</strong><br>
              ${video.filePath}
            </div>
            <p style="font-size: 12px; color: #ff9800; margin-top: 16px; font-weight: bold; margin-bottom: 0;">
              ⚠️ この状態では、動画の再生・クリップ作成・サムネイル生成は行えません。
            </p>
          </div>
        </div>
      `;
      clipPanelHtml = `
        <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 8px; padding: 24px; margin-bottom: 24px; text-align: center; color: var(--subtext); font-size: 13px;">
          🔒 クリップ範囲指定パネルは無効化されています（ファイル未検出のため）
        </div>
      `;
    } else {
      playerHtml = `
        <div style="padding: 16px; background: #000; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow: hidden; min-height: 300px; width: 100%;">
          <video id="video-player" controls preload="metadata" style="width: 100%; max-height: calc(100vh - 450px); object-fit: contain;" src="/api/video/stream/${video.id}"></video>
        </div>
      `;
      clipPanelHtml = `
        <!-- クリップ操作パネル -->
        <div style="background: var(--bg-dark); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 12px; align-items: center;">
            <div style="font-size: 14px; font-weight: bold; color: var(--text);">クリップ範囲指定 (高速モード)</div>
            <div style="font-size: 11px; color: var(--subtext);">※高速モードでは開始位置が少し前後する場合があります。</div>
          </div>
          
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; text-align: center;">
            <div style="background: #222; border-radius: 4px; padding: 8px;">
              <div style="font-size: 11px; color: var(--subtext); margin-bottom: 4px;">開始位置</div>
              <div id="clip-start-time-disp" style="font-family: monospace; font-size: 16px; color: var(--accent);">${this.formatTimeMs(this.state.clipState.startTime)}</div>
              <div style="margin-top: 8px; display: flex; gap: 4px; justify-content: center;">
                <button id="btn-set-start" class="btn btn--sm" style="font-size: 11px;">現在位置を開始に</button>
                <button id="btn-goto-start" class="btn btn--ghost btn--sm" style="font-size: 11px;">移動</button>
              </div>
            </div>
            
            <div style="background: #222; border-radius: 4px; padding: 8px;">
              <div style="font-size: 11px; color: var(--subtext); margin-bottom: 4px;">終了位置</div>
              <div id="clip-end-time-disp" style="font-family: monospace; font-size: 16px; color: var(--accent);">${this.formatTimeMs(this.state.clipState.endTime)}</div>
              <div style="margin-top: 8px; display: flex; gap: 4px; justify-content: center;">
                <button id="btn-set-end" class="btn btn--sm" style="font-size: 11px;">現在位置を終了に</button>
                <button id="btn-goto-end" class="btn btn--ghost btn--sm" style="font-size: 11px;">移動</button>
              </div>
            </div>
            
            <div style="background: #222; border-radius: 4px; padding: 8px; display: flex; flex-direction: column; justify-content: center;">
              <div style="font-size: 11px; color: var(--subtext); margin-bottom: 4px;">クリップ長</div>
              <div id="clip-duration-disp" style="font-family: monospace; font-size: 16px; color: var(--text);">--:--.---</div>
            </div>
          </div>
          
          <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 16px;">
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="-30">-30秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="-15">-15秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="-5">-5秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="-1">-1秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="-0.1">-0.1秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="0.1">+0.1秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="1">+1秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="5">+5秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="15">+15秒</button>
            <button class="btn-jump btn btn--ghost btn--sm" data-jump="30">+30秒</button>
          </div>
          
          <div style="display: flex; gap: 16px; justify-content: center; border-top: 1px solid #333; padding-top: 16px;">
             <button id="btn-preview-range" class="btn btn--primary" style="flex: 1;">▶ 範囲プレビュー</button>
             <button id="btn-save-clip" class="btn" style="flex: 1; background: #e91e63; color: #fff;">🎬 クリップ保存</button>
          </div>
          
          <div id="clip-status-msg" style="margin-top: 12px; text-align: center; font-size: 13px; font-weight: bold;"></div>
          <div id="clip-result-area" style="margin-top: 12px; background: #111; padding: 12px; border-radius: 4px; display: none; font-size: 12px;"></div>
        </div>
      `;
    }
    
    pane.innerHTML = `
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-dark); display: flex; justify-content: space-between; align-items: center; gap: 16px;">
        <h3 style="margin: 0; font-size: 15px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;" title="${video.fileName}">
          ${video.fileName}
        </h3>
        <select id="video-preview-status" class="ctrl-select" style="width: auto; height: 34px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; cursor: pointer;">
          <option value="未確認" ${(!video.status || video.status === '未確認') ? 'selected' : ''}>未確認</option>
          <option value="残す" ${video.status === '残す' ? 'selected' : ''}>残す</option>
          <option value="クリップ化対象" ${video.status === 'クリップ化対象' ? 'selected' : ''}>クリップ化対象</option>
          <option value="クリップ作成済み" ${video.status === 'クリップ作成済み' ? 'selected' : ''}>クリップ作成済み</option>
          <option value="削除候補" ${video.status === '削除候補' ? 'selected' : ''}>削除候補</option>
          <option value="保留" ${video.status === '保留' ? 'selected' : ''}>保留</option>
          <option value="元動画保持" ${video.status === '元動画保持' ? 'selected' : ''}>元動画保持</option>
        </select>
      </div>
      
      ${playerHtml}
      
      <div style="padding: 16px; flex: 1; overflow-y: auto;">
        ${clipPanelHtml}

        <h4 style="margin: 0 0 12px 0; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 8px;">動画情報</h4>
        <div style="display: grid; grid-template-columns: 80px 1fr; gap: 8px; font-size: 13px;">
          <div style="color: var(--subtext);">パス:</div>
          <div style="word-break: break-all; color: var(--text);">${video.filePath}</div>
          <div style="color: var(--subtext);">容量:</div>
          <div>${this.formatBytes(video.size)}</div>
          <div style="color: var(--subtext);">更新日:</div>
          <div>${this.formatDate(video.updatedAt)}</div>
        </div>
        ${video.status === '削除候補' ? `
        <div style="margin-top: 16px; padding: 12px; background: rgba(255,193,7,0.1); border-left: 4px solid #ffc107; font-size: 12px; color: var(--text);">
          <strong>💡 削除候補動画の案内</strong><br>
          この動画は現在「削除候補」に設定されています。画面上部の「🗑️ 整理」タブから手動削除のためのエクスプローラー起動やパスのコピーを行えます。
        </div>
        ` : ''}
      </div>
    `;

    this.bindPreviewEvents(video);
  },
  
  updateClipDurationDisp() {
    const s = this.state.clipState.startTime;
    const e = this.state.clipState.endTime;
    const disp = document.getElementById('clip-duration-disp');
    if (!disp) return;
    
    if (s !== null && e !== null) {
      const dur = e - s;
      disp.textContent = dur > 0 ? this.formatTimeMs(dur) : 'エラー (時間逆転)';
      disp.style.color = dur > 0 ? 'var(--text)' : 'red';
    } else {
      disp.textContent = '--:--.---';
      disp.style.color = 'var(--text)';
    }
  },
  
  bindPreviewEvents(videoInfo) {
    const video = document.getElementById('video-player');
    if (!video) return;
    
    // 範囲プレビューロジック
    video.addEventListener('timeupdate', () => {
      if (this.state.clipState.isPreviewing && this.state.clipState.endTime !== null) {
        if (video.currentTime >= this.state.clipState.endTime) {
          video.pause();
          this.state.clipState.isPreviewing = false;
          const msg = document.getElementById('clip-status-msg');
          if (msg && msg.textContent === '範囲プレビュー中...') {
             msg.textContent = '';
          }
        }
      }
    });

    document.getElementById('btn-set-start')?.addEventListener('click', () => {
      this.state.clipState.startTime = video.currentTime;
      document.getElementById('clip-start-time-disp').textContent = this.formatTimeMs(this.state.clipState.startTime);
      this.updateClipDurationDisp();
    });
    
    document.getElementById('btn-set-end')?.addEventListener('click', () => {
      this.state.clipState.endTime = video.currentTime;
      document.getElementById('clip-end-time-disp').textContent = this.formatTimeMs(this.state.clipState.endTime);
      this.updateClipDurationDisp();
    });

    document.getElementById('btn-goto-start')?.addEventListener('click', () => {
      if (this.state.clipState.startTime !== null) video.currentTime = this.state.clipState.startTime;
    });

    document.getElementById('btn-goto-end')?.addEventListener('click', () => {
      if (this.state.clipState.endTime !== null) video.currentTime = this.state.clipState.endTime;
    });

    document.querySelectorAll('.btn-jump').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const jump = parseFloat(e.target.getAttribute('data-jump'));
        if (!isNaN(jump)) {
           video.currentTime = Math.max(0, video.currentTime + jump);
        }
      });
    });

    document.getElementById('btn-preview-range')?.addEventListener('click', () => {
      if (this.state.clipState.startTime === null || this.state.clipState.endTime === null) {
        alert('開始位置と終了位置を指定してください。');
        return;
      }
      if (this.state.clipState.startTime >= this.state.clipState.endTime) {
        alert('終了位置は開始位置より後に設定してください。');
        return;
      }
      this.state.clipState.isPreviewing = true;
      video.currentTime = this.state.clipState.startTime;
      video.play();
      document.getElementById('clip-status-msg').textContent = '範囲プレビュー中...';
      document.getElementById('clip-status-msg').style.color = 'var(--accent)';
    });

    document.getElementById('btn-save-clip')?.addEventListener('click', async () => {
      if (this.state.clipState.isSaving) return;
      
      const st = this.state.clipState.startTime;
      const et = this.state.clipState.endTime;
      
      if (st === null || et === null) {
        alert('開始位置と終了位置を指定してください。');
        return;
      }
      if (st >= et) {
        alert('終了位置は開始位置より後に設定してください。');
        return;
      }
      
      this.state.clipState.isSaving = true;
      const btnSave = document.getElementById('btn-save-clip');
      const msg = document.getElementById('clip-status-msg');
      btnSave.disabled = true;
      btnSave.style.opacity = '0.5';
      msg.textContent = 'クリップ作成中... (ffmpeg 処理中)';
      msg.style.color = '#fff';
      
      try {
        const res = await fetch('/api/video/clips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: videoInfo.id, startTime: st, endTime: et })
        });
        
        const data = await res.json();
        if (!res.ok) {
           console.error('クリップ保存エラー (バックエンド):', data.error);
           throw new Error(data.error || '保存に失敗しました');
        }
        
        this.state.clipState.lastCreatedClip = data;
        
        // 元動画のステータス更新とクリップ数更新のため、リストを再取得して再描画
        await this.loadVideos();
        // 現在の動画情報を再取得してステータス表示等を更新
        const updatedVideo = this.state.videos.find(v => v.id === videoInfo.id);
        if (updatedVideo) {
          const statusSelect = document.getElementById('video-preview-status');
          if (statusSelect) {
             statusSelect.value = updatedVideo.status;
          }
        }
        
        msg.textContent = '保存完了！';
        msg.style.color = '#4caf50';
        
        const resultArea = document.getElementById('clip-result-area');
        resultArea.style.display = 'block';
        resultArea.innerHTML = `
          <div style="color: #4caf50; font-weight: bold; margin-bottom: 4px;">作成成功</div>
          <div>ファイル名: <span style="color: var(--text);">${data.fileName}</span></div>
          <div>保存先: <span style="color: var(--subtext);">${data.clipPath}</span></div>
          <div>容量: ${this.formatBytes(data.size)} | 長さ: ${data.duration.toFixed(3)}s</div>
          <div style="margin-top: 8px;">
            <button id="btn-play-clip" class="btn btn--sm">作成したクリップを再生</button>
          </div>
        `;
        
        document.getElementById('btn-play-clip').addEventListener('click', () => {
           video.src = `/api/video/clips/stream/${data.id}`;
           video.play();
           msg.textContent = 'クリップを再生中です';
        });

      } catch (err) {
        console.error('クリップ保存エラー:', err);
        msg.innerHTML = `エラー: ${err.message}<br><span style="font-size: 11px; font-weight: normal; color: var(--subtext);">※設定タブでffmpegパスや保存先ディレクトリが正しく設定されているか確認してください。</span>`;
        msg.style.color = 'red';
      } finally {
        this.state.clipState.isSaving = false;
        btnSave.disabled = false;
        btnSave.style.opacity = '1';
      }
    });

    const statusSelect = document.getElementById('video-preview-status');
    if (statusSelect) {
      statusSelect.addEventListener('change', async (e) => {
        const newStatus = e.target.value;
        if (newStatus === '削除候補' && videoInfo.status === '元動画保持') {
           if (!confirm('この動画は「元動画保持」に設定されています。本当に「削除候補」に変更しますか？')) {
             e.target.value = '元動画保持';
             return;
           }
        }
        
        try {
          const res = await fetch(`/api/video/${videoInfo.id}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
          });
          if (res.ok) {
            // ステータス更新成功後、ローカルstateを更新して一覧再描画
            await this.loadVideos();
            if (window.LocalMediaTrash && typeof window.LocalMediaTrash.loadTrash === 'function') {
              window.LocalMediaTrash.loadTrash();
            }
          } else {
            alert('ステータスの更新に失敗しました');
          }
        } catch(err) {
          console.error(err);
          alert('ステータスの更新中にエラーが発生しました');
        }
      });
    }
  }
};

// 読み込み時に初期化を実行
document.addEventListener('DOMContentLoaded', () => {
  ns.App.init();
});
})();
