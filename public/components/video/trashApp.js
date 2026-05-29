(function() {
  const ns = window.LocalMediaVideo || window.FF14SSVideo || {};
  window.LocalMediaVideo = ns;
  window.FF14SSVideo = ns;

  ns.TrashApp = ns.TrashApp || {
  state: {
    videos: [],
    clips: [],
    trashVideos: [],
    manualDeleteVideos: []
  },

  async init() {
    this.render();
    await this.loadData();
  },

  async loadData() {
    try {
      const [videoRes, clipRes, trashListRes] = await Promise.all([
        fetch('/api/video/list'),
        fetch('/api/video/clips'),
        fetch('/api/video/trash/list')
      ]);

      if (videoRes.ok && clipRes.ok && trashListRes.ok) {
        this.state.videos = await videoRes.json();
        this.state.clips = await clipRes.json();
        this.state.manualDeleteVideos = await trashListRes.json();
        
        // 削除候補のみ抽出
        this.state.trashVideos = this.state.videos.filter(v => v.status === '削除候補');
        
        this.renderContent();
      }
    } catch (err) {
      console.error("Failed to load data in TrashApp", err);
    }
  },

  async removeFromTrash(videoId) {
    try {
      const res = await fetch(`/api/video/${videoId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '保留' })
      });
      if (res.ok) {
        // UI上から即座に消すか、再読み込みする
        await this.loadData();
      }
    } catch (err) {
      console.error(err);
      alert('ステータスの更新に失敗しました。');
    }
  },

  copyPath(filePath) {
    navigator.clipboard.writeText(filePath).then(() => {
      alert('ファイルパスをクリップボードにコピーしました！\n' + filePath);
    }).catch(err => {
      console.error('Failed to copy text: ', err);
      // フォールバック
      const t = document.createElement("textarea");
      t.value = filePath;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      document.body.removeChild(t);
      alert('ファイルパスをコピーしました！\n' + filePath);
    });
  },

  async openFolder(filePath) {
    try {
      const res = await fetch('/api/video/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath })
      });
      if (!res.ok) {
        const data = await res.json();
        alert(`エラー: ${data.error || 'フォルダを開くのに失敗しました。'}`);
      }
    } catch (err) {
      console.error(err);
      alert('フォルダを開く際に通信エラーが発生しました。');
    }
  },

  formatBytes(bytes) {
    if (!bytes) return '0 B';
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

  render() {
    const root = document.getElementById('trash-app-root');
    if (!root) return;

    let html = `
      <div style="display: flex; flex-direction: column; height: 100%; gap: 16px; max-width: 1200px; margin: 0 auto; width: 100%;">
        <!-- サマリーカード -->
        <div id="trash-summary" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 24px; display: flex; flex-direction: column; gap: 16px;">
          <!-- ローディングなどの仮表示 -->
        </div>

        <!-- リストエリア -->
        <div style="flex: 1; display: flex; flex-direction: column; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden;">
          <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-dark);">
            <h3 style="margin: 0; font-size: 15px; color: var(--text);">削除候補一覧</h3>
            <button id="btn-refresh-trash" class="btn btn--sm btn--ghost">🔄 更新</button>
          </div>
          
          <div style="display: grid; grid-template-columns: minmax(200px, 1fr) 100px 100px 200px 120px; gap: 16px; padding: 12px 16px; background: var(--bg-card); border-bottom: 1px solid var(--border); font-weight: bold; font-size: 13px; color: var(--text);">
            <div>ファイル名</div>
            <div style="text-align: right;">容量</div>
            <div style="text-align: center;">クリップ数</div>
            <div>状態 / 警告</div>
            <div style="text-align: center;">操作</div>
          </div>
          
          <div id="trash-list-content" style="flex: 1; overflow-y: auto;">
             <!-- 動的生成 -->
          </div>
        </div>
        <!-- 手動削除待ちファイル一覧 (アコーディオン) -->
        <div id="manual-delete-container" style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column;">
          <div id="manual-delete-header" style="padding: 12px 16px; background: var(--bg-dark); cursor: pointer; display: flex; justify-content: space-between; align-items: center; user-select: none;">
            <h3 style="margin: 0; font-size: 14px; color: #ff9800; display: flex; align-items: center; gap: 8px;">
              <span>📂 現在手動削除待ちのファイル (エクスプローラー等で削除可能)</span>
              <span id="manual-delete-badge" style="font-size: 11px; background: rgba(255,152,0,0.15); color: #ff9800; padding: 2px 6px; border-radius: 10px; font-weight: normal;">0 件</span>
            </h3>
            <span id="manual-delete-arrow" style="font-size: 12px; color: var(--subtext); transition: transform 0.2s;">▼</span>
          </div>
          <div id="manual-delete-content" style="display: none; max-height: 250px; overflow-y: auto; flex-direction: column; border-top: 1px solid var(--border);">
            <!-- 動的生成 -->
          </div>
        </div>

        <!-- 下部アクション -->
        <div style="display: flex; flex-direction: column; gap: 12px; padding: 20px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;">
          <h4 style="margin: 0 0 8px 0; color: #ff9800; font-size: 14px; display: flex; align-items: center; gap: 6px;">
            <span>💡 手動削除の手順案内</span>
          </h4>
          <ol style="margin: 0; padding-left: 20px; font-size: 13px; color: var(--subtext); line-height: 1.8;">
            <li>対象の行の「📂 開く」ボタンをクリックすると、エクスプローラーで動画ファイルが選択された状態で開きます。</li>
            <li>「📋 コピー」でパスをコピーして、エクスプローラーやコマンドライン等で直接処理することも可能です。</li>
            <li>不要な動画ファイルをゴミ箱へ移動、または完全削除します。</li>
            <li>実ファイルを削除した後、画面右上の「🔄 更新」を実行すると、実体の無い動画が自動的に「リンク切れ」状態となり、この画面から安全に履歴を削除（メタデータ消去）できるようになります。</li>
          </ol>
        </div>
      </div>
    `;
    root.innerHTML = html;

    // アコーディオン開閉処理
    const mdHeader = document.getElementById('manual-delete-header');
    const mdContent = document.getElementById('manual-delete-content');
    const mdArrow = document.getElementById('manual-delete-arrow');
    if (mdHeader && mdContent && mdArrow) {
      mdHeader.addEventListener('click', () => {
        const isOpen = mdContent.style.display === 'flex';
        mdContent.style.display = isOpen ? 'none' : 'flex';
        mdArrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
      });
    }

    document.getElementById('btn-refresh-trash')?.addEventListener('click', () => {
      this.loadData();
    });
  },

  renderContent() {
    this.renderSummary();
    this.renderList();
    this.renderManualDeleteList();
  },

  renderSummary() {
    const summary = document.getElementById('trash-summary');
    if (!summary) return;

    const vlist = this.state.trashVideos;
    const totalSize = vlist.reduce((acc, v) => acc + (v.size || 0), 0);
    
    // 手動削除待ちの統計 (実ファイルあり／なしに分割)
    const mlist = this.state.manualDeleteVideos;
    const existingMlist = mlist.filter(v => v.fileExists !== false);
    const missingMlist = mlist.filter(v => v.fileExists === false);

    const manualTotalSize = existingMlist.reduce((acc, v) => acc + (v.size || 0), 0);
    const missingTotalSize = missingMlist.reduce((acc, v) => acc + (v.size || 0), 0);

    let clippedCount = 0;
    let unclippedCount = 0;

    vlist.forEach(v => {
      const clipsForVideo = this.state.clips.filter(c => c.sourceVideoId === v.id);
      if (clipsForVideo.length > 0) {
        clippedCount++;
      } else {
        unclippedCount++;
      }
    });

    const totalDeleteCount = vlist.length + existingMlist.length;
    const totalDeleteSize = totalSize + manualTotalSize;

    summary.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <h2 style="margin: 0; color: #f44336; font-size: 20px;">手動整理・削除の確認</h2>
        <div style="display: flex; gap: 24px; font-size: 16px; font-weight: bold; color: var(--text); flex-wrap: wrap;">
          <div>手動削除対象容量: <span style="color: var(--accent);">${this.formatBytes(totalDeleteSize)}</span></div>
          <div>リンク切れ（メタデータのみ）容量: <span style="color: #ff9800;">${this.formatBytes(missingTotalSize)}</span></div>
        </div>
      </div>
      <div style="display: flex; gap: 24px; font-size: 14px; color: var(--subtext); border-top: 1px solid rgba(255,255,255,0.1); padding-top: 16px; flex-wrap: wrap;">
        <div>削除候補の動画: <strong style="color: var(--text);">${vlist.length} 件</strong></div>
        <div>クリップ作成済み: <strong style="color: var(--text);">${clippedCount} 件</strong></div>
        <div>未クリップ: <strong style="${unclippedCount > 0 ? 'color: #f44336;' : 'color: var(--text);'}">${unclippedCount} 件</strong></div>
        <div>手動削除待ち (実ファイルあり): <strong style="${existingMlist.length > 0 ? 'color: #ff9800;' : 'color: var(--text);'}">${existingMlist.length} 件</strong></div>
        <div>リンク切れ (実ファイル未検出): <strong style="${missingMlist.length > 0 ? 'color: #f44336;' : 'color: var(--text);'}">${missingMlist.length} 件</strong></div>
      </div>
      <div style="margin-top: 12px; font-size: 12px; color: var(--subtext); background: rgba(255, 255, 255, 0.02); padding: 10px 14px; border-radius: 4px; border-left: 3px solid var(--border); text-align: left; width: 100%; line-height: 1.6;">
        🛡️ <strong>安全設計ポリシー:</strong><br>
        本アプリは大切な録画データを保護するため、**動画ファイル本体やクリップファイルの自動消去・物理削除機能は実装していません。**<br>
        不要な動画を整理して容量を解放したい場合は、本画面で容量やクリップ作成状況を確認のうえ、対象ファイルのエクスプローラー等を用いて手動で物理削除を行ってください。
      </div>
      ${existingMlist.length > 0 || vlist.length > 0 ? `
      <div style="margin-top: 8px; font-size: 12px; color: #ff9800; background: rgba(255, 152, 0, 0.05); padding: 8px 12px; border-radius: 4px; border-left: 3px solid #ff9800; text-align: left; width: 100%;">
        💡 <strong>手動で物理削除するファイルがあります。</strong>対象の動画ファイルの場所をエクスプローラー等で開き、手動で削除してください。
      </div>
      ` : ''}
      ${missingMlist.length > 0 ? `
      <div style="margin-top: 8px; font-size: 12px; color: #f44336; background: rgba(244, 67, 54, 0.05); padding: 8px 12px; border-radius: 4px; border-left: 3px solid #f44336; text-align: left; width: 100%;">
        ⚠️ <strong>実ファイル未検出の履歴があります。</strong>すでに物理削除済みの場合は、「履歴を削除」ボタンからデータベースのメタデータとキャッシュを安全に消去できます。
      </div>
      ` : ''}
    `;
  },

  renderManualDeleteList() {
    const badge = document.getElementById('manual-delete-badge');
    const container = document.getElementById('manual-delete-content');
    if (!container || !badge) return;

    const mlist = this.state.manualDeleteVideos;
    badge.textContent = `${mlist.length} 件`;

    if (mlist.length === 0) {
      container.innerHTML = `<div style="text-align: center; padding: 24px; color: var(--subtext); font-size: 13px;">手動削除待ちの動画はありません。</div>`;
      return;
    }

    let html = `
      <div style="display: grid; grid-template-columns: minmax(200px, 1fr) 100px 150px 200px; gap: 16px; padding: 8px 16px; background: rgba(0,0,0,0.2); font-weight: bold; font-size: 12px; color: var(--subtext); border-bottom: 1px solid var(--border);">
        <div>ファイル名</div>
        <div style="text-align: right;">容量</div>
        <div style="text-align: center;">状態</div>
        <div style="text-align: center;">操作</div>
      </div>
    `;

    mlist.forEach(v => {
      const isMissing = v.fileExists === false;
      const statusLabel = isMissing
        ? `<span style="color: #f44336; font-weight: bold; font-size: 11px; display: inline-block; padding: 2px 6px; background: rgba(244,67,54,0.1); border-radius: 4px;">❌ 実ファイル未検出</span>`
        : `<span style="color: #ff9800; font-weight: bold; font-size: 11px; display: inline-block; padding: 2px 6px; background: rgba(255,152,0,0.1); border-radius: 4px;">⚠️ 物理削除待ち</span>`;

      const actionButton = isMissing
        ? `<button class="btn-delete-metadata btn btn--sm" data-id="${v.id}" style="font-size: 11px; padding: 4px 8px; background: #e040fb; border-color: #e040fb; color: #fff;">🗑️ 履歴を削除</button>`
        : `
          <div style="display: flex; gap: 4px; justify-content: center;">
            <button class="btn-open-folder-manual btn btn--sm btn--ghost" data-path="${v.filePath}" style="font-size: 11px; padding: 4px 8px;">📂 開く</button>
            <button class="btn-copy-path-manual btn btn--sm btn--ghost" data-path="${v.filePath}" style="font-size: 11px; padding: 4px 8px;">📋 コピー</button>
          </div>
        `;

      html += `
        <div style="display: grid; grid-template-columns: minmax(200px, 1fr) 100px 150px 200px; gap: 16px; padding: 10px 16px; border-bottom: 1px solid #222; align-items: center; font-size: 13px; text-align: left;">
          <div style="word-break: break-all; min-width: 0; color: var(--text);">${v.fileName}</div>
          <div style="text-align: right; color: var(--subtext); font-size: 12px;">${this.formatBytes(v.size)}</div>
          <div style="text-align: center;">${statusLabel}</div>
          <div style="text-align: center;">${actionButton}</div>
        </div>
      `;
    });

    container.innerHTML = html;

    // メタデータ手動削除イベントのバインド
    container.querySelectorAll('.btn-delete-metadata').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const video = mlist.find(v => v.id === id);
        if (!video) return;

        const confirmMsg = `実ファイルが見つからない動画のメタデータを削除します。\n\n` +
          `この操作では実ファイルは削除されませんが、動画一覧・整理タブからこの履歴が完全に消え、サムネイルキャッシュもクリーンアップされます。\n\n` +
          `元に戻せません。よろしいですか？`;

        if (!confirm(confirmMsg)) return;

        try {
          const res = await fetch(`/api/video/trash/metadata/${id}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (res.ok && data.success) {
            alert('メタデータを正常に削除しました。');
            await this.loadData();
          } else {
            alert(`エラー: ${data.error || '削除に失敗しました。'}`);
          }
        } catch (err) {
          console.error(err);
          alert(`通信エラーが発生しました: ${err.message}`);
        }
      });
    });

    // フォルダを開くイベントバインド
    container.querySelectorAll('.btn-open-folder-manual').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const path = e.currentTarget.getAttribute('data-path');
        this.openFolder(path);
      });
    });

    // コピーイベントバインド
    container.querySelectorAll('.btn-copy-path-manual').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const path = e.currentTarget.getAttribute('data-path');
        this.copyPath(path);
      });
    });
  },

  renderList() {
    const container = document.getElementById('trash-list-content');
    if (!container) return;

    if (this.state.trashVideos.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding: 48px; color: var(--subtext);">削除候補の動画はありません。</div>`;
      return;
    }

    // 更新日降順でソート
    const sorted = [...this.state.trashVideos].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    let html = '';
    sorted.forEach(v => {
      const clipsForVideo = this.state.clips.filter(c => c.sourceVideoId === v.id);
      const isUnclipped = clipsForVideo.length === 0;
      
      let warningHtml = '';
      if (isUnclipped) {
        warningHtml = `<span style="color: #f44336; font-weight: bold; font-size: 11px; display: inline-block; padding: 2px 6px; background: rgba(244,67,54,0.1); border-radius: 4px;">⚠️ クリップ未作成</span>`;
      } else {
        warningHtml = `<span style="color: #4CAF50; font-size: 11px;">✅ クリップ ${clipsForVideo.length}件</span>`;
      }

      html += `
        <div style="display: grid; grid-template-columns: minmax(200px, 1fr) 100px 100px 180px 240px; gap: 16px; padding: 12px 16px; border-bottom: 1px solid #222; align-items: center; transition: background 0.2s;">
          <div style="word-break: break-all; min-width: 0;">
            <div style="color: var(--text); font-size: 13px; font-weight: 500;">${v.fileName}</div>
            <div style="color: var(--subtext); font-size: 11px; margin-top: 4px;">更新: ${this.formatDate(v.updatedAt)}</div>
          </div>
          <div style="text-align: right; color: var(--subtext); font-size: 12px;">
            ${this.formatBytes(v.size)}
          </div>
          <div style="text-align: center; color: var(--subtext); font-size: 12px;">
            ${clipsForVideo.length}
          </div>
          <div>
            ${warningHtml}
          </div>
          <div style="text-align: center; display: flex; gap: 6px; justify-content: center;">
            <button class="btn-open-folder-trash btn btn--sm btn--ghost" data-path="${v.filePath}" style="font-size: 11px; padding: 4px 8px;">📂 開く</button>
            <button class="btn-copy-path-trash btn btn--sm btn--ghost" data-path="${v.filePath}" style="font-size: 11px; padding: 4px 8px;">📋 コピー</button>
            <button class="btn-remove-from-trash btn btn--sm btn--ghost" data-id="${v.id}" style="font-size: 11px; padding: 4px 8px; color: #f44336;">候補から外す</button>
          </div>
        </div>
      `;
    });

    // ヘッダーコラム幅の調整（grid-template-columnsを一致させる）
    const listHeader = container.previousElementSibling;
    if (listHeader) {
      listHeader.style.gridTemplateColumns = 'minmax(200px, 1fr) 100px 100px 180px 240px';
    }

    container.innerHTML = html;

    // イベントバインド
    container.querySelectorAll('.btn-remove-from-trash').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        this.removeFromTrash(id);
      });
    });

    // フォルダを開くイベントバインド
    container.querySelectorAll('.btn-open-folder-trash').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const path = e.currentTarget.getAttribute('data-path');
        this.openFolder(path);
      });
    });

    // コピーイベントバインド
    container.querySelectorAll('.btn-copy-path-trash').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const path = e.currentTarget.getAttribute('data-path');
        this.copyPath(path);
      });
    });
  }
};

// 📁 互換性エイリアス
window.LocalMediaTrash = ns.TrashApp;
window.FF14SSTrash = ns.TrashApp;
ns.loadTrash = function() {
  if (typeof ns.TrashApp.init === 'function') {
    ns.TrashApp.init();
  }
};
window.LocalMediaTrash.loadTrash = ns.loadTrash;
window.FF14SSTrash.loadTrash = ns.loadTrash;
})();
