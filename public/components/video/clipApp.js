(function() {
  const ns = window.LocalMediaVideo || window.FF14SSVideo || {};
  window.LocalMediaVideo = ns;
  window.FF14SSVideo = ns;

  ns.ClipApp = ns.ClipApp || {
  state: {
    clips: [],
    directoryFiles: [],
    selectedClipId: null,
    selectedDirPath: null,
    viewMode: 'history', // 'history' or 'directory'
    filter: 'すべて',
    sort: 'newest'
  },

  async init() {
    this.render();
    await this.loadClips();
    await this.loadDirectoryFiles();
  },

  async loadClips() {
    try {
      const res = await fetch('/api/video/clips');
      if (res.ok) {
        this.state.clips = await res.json();
        this.renderClipList();
      }
    } catch (err) {
      console.error("Failed to load clips", err);
    }
  },

  async loadDirectoryFiles() {
    try {
      const res = await fetch('/api/video/clips/directory');
      if (res.ok) {
        this.state.directoryFiles = await res.json();
        if (this.state.viewMode === 'directory') this.renderDirectoryList();
      }
    } catch (err) {
      console.error(err);
    }
  },

  async saveClipMeta(clipId, data) {
    try {
      const res = await fetch(`/api/video/clips/${clipId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        await this.loadClips();
      } else {
        alert('クリップ情報の保存に失敗しました');
      }
    } catch (err) {
      console.error(err);
      alert('通信エラーが発生しました');
    }
  },

  async openFolder(path) {
    try {
      const res = await fetch('/api/video/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      });
      if (!res.ok) {
        alert('保存先を開けません（ファイルが見つからないか、移動された可能性があります）');
      }
    } catch (err) {
      console.error(err);
      alert('エラーが発生しました');
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

  formatTime(seconds) {
    if (seconds === null || seconds === undefined) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  },

  selectClip(id) {
    this.state.selectedClipId = id;
    
    document.querySelectorAll('.clip-list-row').forEach(row => {
      const isSelected = row.getAttribute('data-id') === id;
      row.style.background = isSelected ? 'var(--bg-hover)' : 'transparent';
      const titleDiv = row.querySelector('.clip-list-title');
      if (titleDiv) {
        titleDiv.style.fontWeight = isSelected ? 'bold' : 'normal';
      }
    });

    this.renderPreviewPane(id);
  },

  selectDirFile(path) {
    this.state.selectedDirPath = path;
    
    document.querySelectorAll('.clip-dir-row').forEach(row => {
      const isSelected = row.getAttribute('data-path') === path;
      row.style.background = isSelected ? 'var(--bg-hover)' : 'transparent';
      const titleDiv = row.querySelector('.clip-dir-title');
      if (titleDiv) {
        titleDiv.style.fontWeight = isSelected ? 'bold' : 'normal';
      }
    });

    this.renderDirPreviewPane(path);
  },

  render() {
    const root = document.getElementById('clip-app-root');
    if (!root) return;

    let html = `
      <div style="display: flex; height: 100%; gap: 16px;">
        <div style="flex: 0 0 auto; width: 450px; min-width: 360px; max-width: 50vw; resize: horizontal; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;">
          <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-dark);">
            <div style="display: flex; gap: 8px;">
              <button id="clip-tab-history" class="btn btn--sm ${this.state.viewMode === 'history' ? 'btn--primary' : 'btn--ghost'}">履歴</button>
              <button id="clip-tab-directory" class="btn btn--sm ${this.state.viewMode === 'directory' ? 'btn--primary' : 'btn--ghost'}">フォルダ内</button>
            </div>
            <button id="btn-refresh-clips" class="btn btn--sm btn--ghost">🔄 更新</button>
          </div>
          
          <!-- サマリー表示エリア -->
          <div id="clip-summary-area" style="padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-card); display: flex; justify-content: space-between; font-size: 11px; color: var(--subtext);">
            <!-- 動的更新 -->
          </div>

          <!-- 履歴用コントロール群 -->
          <div id="clip-history-controls" style="display: ${this.state.viewMode === 'history' ? 'block' : 'none'}; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--sidebar);">
            <div style="display: flex; gap: 8px;">
              <select id="clip-filter-select" class="ctrl-select" style="flex: 1; height: 34px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; cursor: pointer;">
                <option value="すべて" ${this.state.filter === 'すべて' ? 'selected' : ''}>すべて</option>
                <option value="お気に入り" ${this.state.filter === 'お気に入り' ? 'selected' : ''}>お気に入り</option>
                <option value="タグあり" ${this.state.filter === 'タグあり' ? 'selected' : ''}>タグあり</option>
                <option value="メモあり" ${this.state.filter === 'メモあり' ? 'selected' : ''}>メモあり</option>
              </select>
              <select id="clip-sort-select" class="ctrl-select" style="flex: 1; height: 34px; padding: 6px 12px; font-size: 13px; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; cursor: pointer;">
                <option value="newest" ${this.state.sort === 'newest' ? 'selected' : ''}>作成日時 新しい順</option>
                <option value="oldest" ${this.state.sort === 'oldest' ? 'selected' : ''}>作成日時 古い順</option>
                <option value="size" ${this.state.sort === 'size' ? 'selected' : ''}>容量 大きい順</option>
                <option value="duration" ${this.state.sort === 'duration' ? 'selected' : ''}>長さ 長い順</option>
                <option value="source" ${this.state.sort === 'source' ? 'selected' : ''}>元動画名順</option>
              </select>
            </div>
          </div>

          <div class="clip-list-header" style="display: grid; grid-template-columns: 1fr 100px; gap: 8px; padding: 8px 12px; background: var(--bg-card); border-bottom: 1px solid var(--border); font-weight: bold; font-size: 13px; color: var(--text);">
            <div>ファイル名 / 詳細</div>
            <div style="text-align: right;">時間 / 容量</div>
          </div>
          <div id="clip-list-scroll-container" style="flex: 1; overflow-y: auto;">
            <div id="clip-list-content" style="display: flex; flex-direction: column;">
               <!-- 動的生成 -->
            </div>
          </div>
        </div>
        
        <div id="clip-preview-pane" style="flex: 1; display: none; flex-direction: column; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; min-width: 400px;">
        </div>
      </div>
    `;
    root.innerHTML = html;

    document.getElementById('btn-refresh-clips')?.addEventListener('click', () => {
      if (this.state.viewMode === 'history') {
        this.loadClips();
      } else {
        this.loadDirectoryFiles();
      }
    });

    document.getElementById('clip-tab-history')?.addEventListener('click', () => {
      this.state.viewMode = 'history';
      this.render();
      this.renderClipList();
    });

    document.getElementById('clip-tab-directory')?.addEventListener('click', () => {
      this.state.viewMode = 'directory';
      this.render();
      this.renderDirectoryList();
    });

    document.getElementById('clip-filter-select')?.addEventListener('change', (e) => {
      this.state.filter = e.target.value;
      this.renderClipList();
    });

    document.getElementById('clip-sort-select')?.addEventListener('change', (e) => {
      this.state.sort = e.target.value;
      this.renderClipList();
    });
  },

  renderClipList() {
    const container = document.getElementById('clip-list-content');
    if (!container) return;

    let clips = this.state.clips || [];
    const totalSize = clips.reduce((acc, c) => acc + (c.size || 0), 0);
    const totalCount = clips.length;
    
    // フィルタ
    if (this.state.filter === 'お気に入り') {
      clips = clips.filter(c => c.isFavorite);
    } else if (this.state.filter === 'タグあり') {
      clips = clips.filter(c => c.tags && c.tags.length > 0);
    } else if (this.state.filter === 'メモあり') {
      clips = clips.filter(c => c.memo && c.memo.trim() !== '');
    }

    // ソート
    const sorted = [...clips].sort((a, b) => {
      if (this.state.sort === 'oldest') {
        return new Date(a.createdAt) - new Date(b.createdAt);
      } else if (this.state.sort === 'size') {
        return b.size - a.size;
      } else if (this.state.sort === 'duration') {
        return b.duration - a.duration;
      } else if (this.state.sort === 'source') {
        return (a.sourceVideoPath || '').localeCompare(b.sourceVideoPath || '');
      } else {
        // newest (default)
        return new Date(b.createdAt) - new Date(a.createdAt);
      }
    });
    
    const filteredSize = sorted.reduce((acc, c) => acc + (c.size || 0), 0);
    const summaryArea = document.getElementById('clip-summary-area');
    if (summaryArea) {
      if (this.state.filter === 'すべて') {
        summaryArea.innerHTML = `<div>全体: <span style="color:var(--text);">${totalCount}件 / ${this.formatBytes(totalSize)}</span></div>`;
      } else {
        summaryArea.innerHTML = `
          <div>全体: <span style="color:var(--text);">${totalCount}件 / ${this.formatBytes(totalSize)}</span></div>
          <div>表示: <span style="color:var(--text);">${sorted.length}件 / ${this.formatBytes(filteredSize)}</span></div>
        `;
      }
    }

    let html = '';

    if (sorted.length === 0) {
      html = `<div style="text-align:center; padding: 32px; color: var(--subtext);">表示できるクリップがありません。</div>`;
    } else {
      sorted.forEach(c => {
        const isSelected = this.state.selectedClipId === c.id;
        const bg = isSelected ? 'var(--bg-hover)' : 'transparent';
        const fileWarning = c.fileExists === false ? `<span style="color:#f44336; font-weight:bold; font-size:10px; margin-left:8px;">[ファイルなし]</span>` : '';
        
        html += `
          <div class="clip-list-row" data-id="${c.id}" style="display: grid; grid-template-columns: 1fr 100px; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #222; cursor: pointer; background: ${bg}; transition: background 0.2s; align-items: center; opacity: ${c.fileExists === false ? '0.5' : '1'};">
            <div style="word-break: break-all; min-width: 0;">
              <div class="clip-list-title" style="font-weight: ${isSelected ? 'bold' : 'normal'}; color: var(--text); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${c.favorite ? '<span style="color:var(--accent);">★</span> ' : ''}${c.fileName}${fileWarning}
              </div>
              <div style="font-size: 11px; color: var(--subtext); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${(c.tags && c.tags.length > 0) ? `<span style="background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 2px; margin-right: 4px;">🏷️ ${c.tags.length}</span>` : ''}
                ${c.memo ? `<span style="background: rgba(255,255,255,0.1); padding: 1px 4px; border-radius: 2px; margin-right: 4px;">📝</span>` : ''}
                元動画: ${c.sourceVideoPath.split(/[\\/]/).pop()}
              </div>
            </div>
            <div style="text-align: right; font-size: 11px; color: var(--subtext);">
              <div style="color: var(--accent); font-weight: bold;">${this.formatTime(c.duration)}</div>
              <div style="margin-top: 4px;">${this.formatBytes(c.size)}</div>
            </div>
          </div>
        `;
      });
    }

    container.innerHTML = html;

    document.querySelectorAll('.clip-list-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        this.selectClip(id);
      });
    });
    
    if (this.state.selectedClipId) {
       this.renderPreviewPane(this.state.selectedClipId);
    } else {
       document.getElementById('clip-preview-pane').style.display = 'none';
    }
  },

  renderDirectoryList() {
    const container = document.getElementById('clip-list-content');
    if (!container) return;

    const files = this.state.directoryFiles || [];
    const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
    
    const summaryArea = document.getElementById('clip-summary-area');
    if (summaryArea) {
      summaryArea.innerHTML = `<div>Clipフォルダ: <span style="color:var(--text);">${files.length}件 / ${this.formatBytes(totalSize)}</span></div>`;
    }

    let html = '';

    if (files.length === 0) {
      html = `<div style="text-align:center; padding: 32px; color: var(--subtext);">フォルダ内に動画が見つかりません。</div>`;
    } else {
      const sorted = [...files].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      sorted.forEach(f => {
        const isSelected = this.state.selectedDirPath === f.filePath;
        const bg = isSelected ? 'var(--bg-hover)' : 'transparent';
        
        html += `
          <div class="clip-dir-row" data-path="${f.filePath}" style="display: grid; grid-template-columns: 1fr 100px; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #222; cursor: pointer; background: ${bg}; transition: background 0.2s; align-items: center;">
            <div style="word-break: break-all; min-width: 0;">
              <div class="clip-dir-title" style="font-weight: ${isSelected ? 'bold' : 'normal'}; color: var(--text); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${f.fileName}</div>
              <div style="font-size: 11px; color: var(--subtext); margin-top: 4px;">
                ${this.formatDate(f.updatedAt)}
              </div>
            </div>
            <div style="text-align: right; font-size: 11px; color: var(--subtext);">
              <div style="margin-top: 4px;">${this.formatBytes(f.size)}</div>
            </div>
          </div>
        `;
      });
    }

    container.innerHTML = html;

    document.querySelectorAll('.clip-dir-row').forEach(row => {
      row.addEventListener('click', (e) => {
        const path = e.currentTarget.getAttribute('data-path');
        this.selectDirFile(path);
      });
    });
    
    if (this.state.selectedDirPath) {
       this.renderDirPreviewPane(this.state.selectedDirPath);
    } else {
       document.getElementById('clip-preview-pane').style.display = 'none';
    }
  },

  renderPreviewPane(id) {
    const pane = document.getElementById('clip-preview-pane');
    if (!pane) return;

    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) {
      pane.style.display = 'none';
      return;
    }

    pane.style.display = 'flex';
    
    const isMissing = clip.fileExists === false;
    const missingWarningHtml = isMissing ? `
      <div style="padding: 12px; background: rgba(244, 67, 54, 0.1); border-bottom: 1px solid #f44336; color: #f44336; font-size: 13px; font-weight: bold; text-align: center;">
        ⚠️ 実ファイルが見つかりません。ファイルが移動または削除された可能性があります。
      </div>
    ` : '';
    
    const videoHtml = isMissing 
      ? `<div style="color: var(--subtext); font-size: 14px;">再生できません</div>`
      : `<video id="clip-player" controls preload="metadata" style="width: 100%; max-height: calc(100vh - 400px); object-fit: contain;" src="/api/video/clips/stream/${clip.id}"></video>`;

    pane.innerHTML = `
      ${missingWarningHtml}
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-dark); display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin: 0; font-size: 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80%;">
          ${clip.fileName}
        </h3>
        <span style="font-size: 11px; color: var(--subtext);">作成日: ${this.formatDate(clip.createdAt)}</span>
      </div>
      <div style="padding: 16px; background: #000; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow: hidden; min-height: 300px;">
        ${videoHtml}
      </div>
      <div style="padding: 16px; flex: 1; overflow-y: auto;">
        
        <!-- お気に入り・ジャンプ・フォルダ操作ボタン群 -->
        <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;">
          <button id="btn-clip-favorite" class="btn btn--sm ${clip.favorite ? 'btn--primary' : 'btn--ghost'}" style="flex: 1; min-width: 120px;">
            ${clip.favorite ? '★ お気に入り' : '☆ お気に入り'}
          </button>
          <button id="btn-clip-open-src" class="btn btn--sm btn--ghost" style="flex: 1; min-width: 120px;">🎬 元動画を開く</button>
          <button id="btn-clip-open-dir" class="btn btn--sm btn--ghost" style="flex: 1; min-width: 120px;" ${isMissing ? 'disabled' : ''}>
            ${isMissing ? '📁 ファイルなし' : '📁 保存先を開く'}
          </button>
        </div>

        <!-- タグ編集領域 -->
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; color: var(--subtext); margin-bottom: 4px;">タグ (カンマ区切り)</label>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="input-clip-tags" class="form-control" value="${(clip.tags || []).join(', ')}" placeholder="例: 戦闘, ムービー, 推しシーン" style="flex: 1; padding: 6px; font-size: 13px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px;">
            <button id="btn-save-clip-tags" class="btn btn--sm btn--ghost">保存</button>
          </div>
        </div>

        <!-- メモ編集領域 -->
        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 12px; color: var(--subtext); margin-bottom: 4px;">メモ</label>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <textarea id="input-clip-memo" class="form-control" rows="3" placeholder="クリップのメモ..." style="width: 100%; padding: 8px; font-size: 13px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; resize: vertical;">${clip.memo || ''}</textarea>
            <div style="text-align: right;">
              <button id="btn-save-clip-memo" class="btn btn--sm btn--ghost">メモを保存</button>
            </div>
          </div>
        </div>

        <h4 style="margin: 0 0 12px 0; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 8px;">クリップ詳細</h4>
        <div style="display: grid; grid-template-columns: 80px 1fr; gap: 8px; font-size: 13px;">
          <div style="color: var(--subtext);">保存先:</div>
          <div style="word-break: break-all; color: var(--text); ${isMissing ? 'text-decoration: line-through; opacity: 0.5;' : ''}">${clip.clipPath}</div>
          <div style="color: var(--subtext);">元動画:</div>
          <div style="word-break: break-all; color: var(--text);">${clip.sourceVideoPath}</div>
          <div style="color: var(--subtext);">容量:</div>
          <div style="color: var(--text);">${this.formatBytes(clip.size)}</div>
          <div style="color: var(--subtext);">長さ:</div>
          <div style="color: var(--text);">${(clip.duration || 0).toFixed(2)} 秒</div>
        </div>
      </div>
    `;

    // ----------------------------
    // イベントバインド
    // ----------------------------
    const btnFav = pane.querySelector('#btn-clip-favorite');
    if (btnFav) {
      btnFav.addEventListener('click', () => {
        this.saveClipMeta(clip.id, { favorite: !clip.favorite });
      });
    }

    const btnTags = pane.querySelector('#btn-save-clip-tags');
    const inputTags = pane.querySelector('#input-clip-tags');
    if (btnTags && inputTags) {
      btnTags.addEventListener('click', () => {
        const tags = inputTags.value;
        this.saveClipMeta(clip.id, { tags });
      });
    }

    const btnMemo = pane.querySelector('#btn-save-clip-memo');
    const inputMemo = pane.querySelector('#input-clip-memo');
    if (btnMemo && inputMemo) {
      btnMemo.addEventListener('click', () => {
        const memo = inputMemo.value;
        this.saveClipMeta(clip.id, { memo });
      });
    }

    const btnOpenDir = pane.querySelector('#btn-clip-open-dir');
    if (btnOpenDir) {
      btnOpenDir.addEventListener('click', () => {
        if (!isMissing) {
          this.openFolder(clip.clipPath);
        }
      });
    }

    const btnOpenSrc = pane.querySelector('#btn-clip-open-src');
    if (btnOpenSrc) {
      btnOpenSrc.addEventListener('click', () => {
        // global tab を動画に切り替える
        document.querySelector('.global-tab[data-target="video"]')?.click();
        // videoApp側で動画を選択状態にする
        if (ns && ns.VideoApp) {
          ns.VideoApp.selectVideo(clip.sourceVideoId);
          
          // 可能ならスクロール位置を合わせる
          setTimeout(() => {
            const row = document.querySelector(`.video-row[data-id="${clip.sourceVideoId}"]`);
            if (row) {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 100);
        }
      });
    }
  },

  renderDirPreviewPane(path) {
    const pane = document.getElementById('clip-preview-pane');
    if (!pane) return;

    const file = this.state.directoryFiles.find(f => f.filePath === path);
    if (!file) {
      pane.style.display = 'none';
      return;
    }

    pane.style.display = 'flex';

    pane.innerHTML = `
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-dark); display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin: 0; font-size: 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80%;">
          ${file.fileName}
        </h3>
        <span style="font-size: 11px; color: var(--subtext);">更新: ${this.formatDate(file.updatedAt)}</span>
      </div>
      <div style="padding: 16px; background: #000; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow: hidden; min-height: 300px;">
        <video id="clip-dir-player" controls preload="metadata" style="width: 100%; max-height: calc(100vh - 400px); object-fit: contain;" src="/api/video/clips/directory/stream?path=${encodeURIComponent(file.filePath)}"></video>
      </div>
      <div style="padding: 16px; flex: 1; overflow-y: auto;">
        <h4 style="margin: 0 0 12px 0; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 8px;">ファイル情報 (再生専用)</h4>
        <div style="display: grid; grid-template-columns: 80px 1fr; gap: 8px; font-size: 13px;">
          <div style="color: var(--subtext);">絶対パス:</div>
          <div style="word-break: break-all; color: var(--text);">${file.filePath}</div>
          <div style="color: var(--subtext);">容量:</div>
          <div>${this.formatBytes(file.size)}</div>
        </div>
      </div>
    `;
  }
};
})();
