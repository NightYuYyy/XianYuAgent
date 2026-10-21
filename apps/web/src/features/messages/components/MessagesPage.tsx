import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccountContext } from '../../../app/account-context';
import { createMessagesApi, type MessagesApi } from '../api';
import { appendImageAttachments, clipboardImageFiles, type PendingImageAttachment } from '../attachments';
import { canSubmitComposer, insertXianyuEmojiMarker, MESSAGES_COMPOSER_PLACEHOLDER, moveXianyuEmojiCursor, removeXianyuEmojiMarkerAtCursor } from '../composer';
import { normalizeError, useMessagesController } from '../controller';
import { filterConversations } from '../model';
import { emojiURL, renderXianyuTextWithCaret, xianyuEmojis } from '../xianyu-emojis';
import { ConnectionBanner } from './ConnectionBanner';
import { ConversationList, ConversationListState } from './ConversationList';
import { MessageTimeline } from './MessageTimeline';
import { ConversationListSkeleton, TimelineSkeleton } from './MessagesSkeletons';
import { SearchField } from '../../../shared/ui/SearchField';
import './messages.css';

export function MessagesPage({ api: providedApi, active = true }: { api?: MessagesApi; active?: boolean }) {
  const { accounts, currentAccountId, currentAccount, accountsLoading, accountsError } = useAccountContext();
  const api = useMemo(() => providedApi ?? createMessagesApi({ get: async () => { throw new Error('messages api unavailable'); } }), [providedApi]);
  const controller = useMessagesController({ api, accountId: currentAccountId, enabled: active });
  const initialConversationId = useMemo(() => typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search).get('conversationId') ?? undefined, []);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([]);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
  const [chatImagePreviewUrl, setChatImagePreviewUrl] = useState<string | null>(null);
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 });
  const [composerFocused, setComposerFocused] = useState(false);
  const [suggestPhase, setSuggestPhase] = useState<'idle' | 'loading' | 'skip' | 'error'>('idle');
  const [suggestNote, setSuggestNote] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const composerToolsRef = useRef<HTMLDivElement>(null);
  const pendingImagesRef = useRef<PendingImageAttachment[]>([]);
  const activeConversation = controller.state.conversations.find((conversation) => conversation.conversationId === controller.state.activeConversationId);
  const visibleConversations = useMemo(() => filterConversations(controller.state.conversations, search, unreadOnly), [controller.state.conversations, search, unreadOnly]);
  const conversationsLoading = controller.state.listPhase === 'loading';
  const handlingMode = activeConversation?.handlingMode ?? 'ai';
  const buyerSideConversation = activeConversation?.side === 'buyer';

  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);

  useEffect(() => {
    if (!initialConversationId || controller.state.listPhase !== 'success' || controller.state.activeConversationId === initialConversationId) return;
    if (controller.state.conversations.some((conversation) => conversation.conversationId === initialConversationId)) controller.setActiveConversation(initialConversationId);
  }, [controller, initialConversationId, controller.state.activeConversationId, controller.state.conversations, controller.state.listPhase]);

  useEffect(() => () => {
    pendingImagesRef.current.forEach((item) => URL.revokeObjectURL(item.url));
  }, []);

  useEffect(() => {
    setDraft('');
    setComposerSelection({ start: 0, end: 0 });
    setComposerFocused(false);
    setEmojiOpen(false);
    setPendingImages((previous) => {
      previous.forEach((item) => URL.revokeObjectURL(item.url));
      return [];
    });
    setAttachmentPreviewUrl(null);
    setChatImagePreviewUrl(null);
    setSuggestPhase('idle');
    setSuggestNote('');
  }, [controller.state.activeConversationId, currentAccountId]);

  useEffect(() => {
    if (!attachmentPreviewUrl && !chatImagePreviewUrl) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAttachmentPreviewUrl(null); setChatImagePreviewUrl(null); } };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [attachmentPreviewUrl, chatImagePreviewUrl]);

  const addImageFiles = (files: readonly (File | null | undefined)[]) => {
    setPendingImages((previous) => appendImageAttachments(previous, files));
    setAttachmentPreviewUrl(null);
  };

  const removePendingImage = (attachmentId: string) => {
    setPendingImages((previous) => {
      const removed = previous.find((item) => item.id === attachmentId);
      if (removed) URL.revokeObjectURL(removed.url);
      if (attachmentPreviewUrl === removed?.url) setAttachmentPreviewUrl(null);
      return previous.filter((item) => item.id !== attachmentId);
    });
  };

  const resizeComposer = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  };

  useEffect(() => { requestAnimationFrame(resizeComposer); }, [draft]);

  const insertEmoji = (name: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const result = insertXianyuEmojiMarker(draft, start, end, name);
    setDraft(result.value);
    setComposerSelection({ start: result.cursor, end: result.cursor });
    setComposerFocused(true);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(result.cursor, result.cursor);
      resizeComposer();
    });
  };

  const syncComposerSelection = (textarea: HTMLTextAreaElement) => {
    setComposerSelection({ start: textarea.selectionStart ?? 0, end: textarea.selectionEnd ?? 0 });
  };

  const normalizeComposerSelection = (textarea: HTMLTextAreaElement) => {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if (start === end) {
      const snapped = moveXianyuEmojiCursor(textarea.value, start, 'ArrowRight');
      if (snapped !== start) textarea.setSelectionRange(snapped, snapped);
    }
    syncComposerSelection(textarea);
  };

  useEffect(() => {
    if (!emojiOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (composerToolsRef.current?.contains(event.target as Node)) return;
      setEmojiOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [emojiOpen]);

  const handleToggleHandlingMode = async () => {
    if (!activeConversation || modeBusy) return;
    setModeBusy(true);
    setSuggestNote('');
    try {
      await controller.setHandlingMode(activeConversation.handlingMode === 'human' ? 'ai' : 'human');
    } catch (error) {
      setSuggestPhase('error');
      setSuggestNote(`切换失败：${normalizeError(error).message}`);
    } finally {
      setModeBusy(false);
    }
  };

  const handleSuggestReply = async () => {
    if (!activeConversation || suggestPhase === 'loading') return;
    setSuggestPhase('loading');
    setSuggestNote('');
    try {
      const suggestion = await controller.suggestReply();
      if (!suggestion) { setSuggestPhase('idle'); return; }
      if (suggestion.decision === 'skip' || !suggestion.text) {
        setSuggestPhase('skip');
        setSuggestNote(suggestion.reason ? `AI 认为这条暂时不用回（${suggestion.reason}）` : 'AI 认为这条暂时不用回');
        return;
      }
      const text = suggestion.text;
      setDraft(text);
      setComposerSelection({ start: text.length, end: text.length });
      setSuggestPhase('idle');
      setSuggestNote('已填入 AI 草稿，改好后再发送');
      setTimeout(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(text.length, text.length);
      }, 0);
    } catch (error) {
      setSuggestPhase('error');
      setSuggestNote(`AI 拟稿失败：${normalizeError(error).message}`);
    }
  };

  const handleComposerSubmit = async () => {
    if (controller.state.sendPhase === 'submitting') return;
    const text = draft.trim();
    if (!canSubmitComposer(text, pendingImages.length > 0)) return;
    if (text) {
      try {
        await controller.sendMessage(text);
        setDraft('');
      } catch {
        return;
      }
    }
    for (const image of pendingImages) {
      try {
        await controller.sendImage(image.file);
        removePendingImage(image.id);
      } catch {
        return;
      }
    }
    setEmojiOpen(false);
  };

  if (accountsLoading) return <section className="page-stack messages-domain"><div className="messages-state">正在加载账号范围…</div></section>;
  if (accountsError) return <section className="page-stack messages-domain"><div className="messages-state messages-error" role="alert">{accountsError}</div></section>;
  if (accounts.length === 0) return <section className="page-stack messages-domain"><div className="messages-state"><strong>请先连接闲鱼账号</strong><span>在线聊天需要先在账号管理中连接至少一个可用账号。</span><a className="btn ghost" href="/accounts">前往账号管理</a></div></section>;
  if (!currentAccountId || !currentAccount) return <section className="page-stack messages-domain"><div className="messages-state"><strong>请先设置当前账号</strong><span>聊天页沿用账号管理中的全局账号上下文，不在此处切换账号。</span><a className="btn ghost" href="/accounts">前往账号管理</a></div></section>;

  return <section className="page-stack messages-domain" data-messages-domain>
    <div className="messages-layout card panel">
      <h1 className="messages-visually-hidden">在线聊天</h1>
      <aside className="messages-sidebar">
        <div className="messages-sidebar-header"><div><strong>会话</strong>{conversationsLoading ? <small className="messages-header-loading" role="status" aria-label="正在加载会话"><span className="messages-header-loading-line" aria-hidden="true" /></small> : <small>{controller.state.conversations.length} 个已加载{controller.state.hasMore ? '，还有更多' : ''}</small>}</div><button className="icon-button messages-refresh-button" type="button" onClick={() => void controller.reload()} aria-label="刷新会话" title="刷新会话"><svg className="messages-refresh-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-3L4 10" /><path d="M4 5v5h5" /><path d="M4 13a8 8 0 0 0 14.7 3L20 14" /><path d="M20 19v-5h-5" /></svg></button></div>
        <div className="messages-sidebar-tools">
          <SearchField className="messages-search" aria-label="搜索会话" placeholder="搜索用户、商品或消息" value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch('')} clearable />
          <div className="messages-filter-tabs" aria-label="会话筛选"><button type="button" aria-pressed={!unreadOnly} className={!unreadOnly ? 'active' : ''} onClick={() => setUnreadOnly(false)}>全部会话</button><button type="button" aria-pressed={unreadOnly} className={unreadOnly ? 'active' : ''} onClick={() => setUnreadOnly(true)}>未读{controller.state.conversations.filter((item) => item.unreadCount > 0).length ? ` (${controller.state.conversations.filter((item) => item.unreadCount > 0).length})` : ''}</button></div>
        </div>
        {controller.state.listPhase === 'loading' && <ConversationListSkeleton />}
        {controller.state.listPhase === 'empty' && <ConversationListState>当前账号暂无会话。</ConversationListState>}
        {controller.state.listPhase === 'forbidden' && <ConversationListState error role="alert">无权读取该账号会话。</ConversationListState>}
        {controller.state.listPhase === 'error' && <ConversationListState error role="alert">{controller.state.error?.message}<button className="btn ghost" type="button" onClick={() => void controller.reload()}>重试</button></ConversationListState>}
        {controller.state.listPhase === 'success' && visibleConversations.length === 0 && <ConversationListState><strong>没有匹配的会话</strong><span>试试用户昵称、商品标题或最后一条消息。</span></ConversationListState>}
        {controller.state.listPhase === 'success' && visibleConversations.length > 0 && <ConversationList conversations={visibleConversations} activeConversationId={controller.state.activeConversationId} onSelect={controller.setActiveConversation} hasMore={Boolean(search.trim() === '' && !unreadOnly && controller.state.hasMore)} loadingMore={controller.state.loadingMore} onLoadMore={() => void controller.loadMoreConversations()} />}
      </aside>
      <main className="messages-main">
        <header className="messages-main-header">
          <div className="messages-main-identity">
            <span className="messages-main-avatar">{activeConversation?.buyerAvatarUrl ? <img src={activeConversation.buyerAvatarUrl} alt="" /> : (activeConversation?.buyerDisplayName || activeConversation?.buyerRef || '会').slice(0, 1)}</span>
            <div><strong>{activeConversation?.buyerDisplayName || activeConversation?.buyerRef || '选择会话'}</strong><small>{activeConversation ? `用户 ID：${activeConversation.buyerRef}` : '从左侧选择一个会话'}</small></div>
          </div>
          <div className="messages-main-header-meta"><span>{activeConversation?.itemTitle || '未关联商品'}</span><span className="messages-live-badge">真实连接</span><span className={`messages-connection-dot ${controller.state.realtimePhase}`} aria-hidden="true" /><ConnectionBanner phase={controller.state.realtimePhase} onRetry={controller.retryRealtime} /></div>
        </header>
        {controller.state.activeConversationId ? <>
          <MessageTimeline
            messages={controller.state.messages}
            phase={controller.state.timelinePhase}
            hasMoreHistory={controller.state.hasMoreHistory}
            loadingMoreHistory={controller.state.loadingMoreHistory}
            onLoadMore={() => void controller.loadMoreMessages()}
            onOpenImage={setChatImagePreviewUrl}
            inboundParticipant={{ displayName: activeConversation?.buyerDisplayName || activeConversation?.buyerRef || '买家', avatarUrl: activeConversation?.buyerAvatarUrl }}
            outboundParticipant={{ displayName: currentAccount.displayName || currentAccount.sellerRef || '我', avatarUrl: currentAccount.avatarUrl }}
          />
          <form className="messages-composer" onSubmit={(event) => { event.preventDefault(); void handleComposerSubmit(); }}>
            <div className="messages-composer-inner">
              <div className="messages-composer-shell">
                {pendingImages.length > 0 && <div className="messages-inline-attachments" aria-label="待发送附件">
                  {pendingImages.map((pendingImage, index) => <div key={pendingImage.id} className="messages-inline-attachment">
                    <button className="messages-inline-attachment-trigger" type="button" aria-label={`预览待发送图片 ${index + 1}`} onClick={() => setAttachmentPreviewUrl(pendingImage.url)}>
                      <img src={pendingImage.url} alt="待发送图片缩略图" />
                    </button>
                    <button className="messages-attachment-remove" type="button" aria-label={`移除附件 ${index + 1}`} onClick={() => removePendingImage(pendingImage.id)}>×</button>
                  </div>)}
                </div>}
                <div className="messages-composer-assist-row">
                  <div ref={composerToolsRef} className="messages-composer-tools">
                    <button className="messages-tool-button" type="button" aria-label="添加图片附件" onClick={() => { setEmojiOpen(false); imageInputRef.current?.click(); }}>+</button>
                    <button className="messages-tool-button messages-emoji-button" type="button" aria-label="插入闲鱼表情" aria-expanded={emojiOpen} onClick={() => setEmojiOpen((open) => !open)}>☺</button>
                    {activeConversation && <span className="messages-handling-group" data-handling-mode={handlingMode}>
                      <span className={`messages-handling-chip ${buyerSideConversation ? 'buyer' : handlingMode}`} title={buyerSideConversation ? '这是你去咨询别人的商品，自动回复不会介入' : handlingMode === 'human' ? '已人工接管：买家消息只提醒你，AI 不会自动回复' : 'AI 正在自动回复这个会话；你手动发一条也会优先于 AI'}>{buyerSideConversation ? '我在买 · 不自动回复' : handlingMode === 'human' ? '已人工接管' : 'AI 自动回复中'}</span>
                      {!buyerSideConversation && <button className="messages-handling-toggle" type="button" disabled={modeBusy} data-testid="handling-mode-toggle" onClick={() => void handleToggleHandlingMode()}>{modeBusy ? '切换中…' : handlingMode === 'human' ? '交还 AI' : '我来接管'}</button>}
                      <button className="messages-suggest-button" type="button" disabled={suggestPhase === 'loading'} data-testid="suggest-reply" onClick={() => void handleSuggestReply()}>{suggestPhase === 'loading' ? 'AI 拟稿中…' : 'AI 帮我拟一条'}</button>
                      {suggestNote && <span className={`messages-suggest-note ${suggestPhase}`} role={suggestPhase === 'error' ? 'alert' : 'status'}>{suggestNote}</span>}
                    </span>}
                    <input ref={imageInputRef} className="messages-file-input" type="file" accept="image/*" multiple onChange={(event) => { addImageFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ''; }} />
                    {emojiOpen && <div className="messages-emoji-picker" role="dialog" aria-label="闲鱼表情选择器">{xianyuEmojis.map(([name, url], index) => <button key={`${name}-${index}`} type="button" aria-label={`插入${name}`} title={name} onClick={() => insertEmoji(name)}><img src={emojiURL(url)} alt={name} /></button>)}</div>}
                  </div>
                </div>
                <div className="messages-composer-editor">
                  {draft && <div className="messages-composer-visual" aria-hidden="true">{renderXianyuTextWithCaret(draft, composerFocused && composerSelection.start === composerSelection.end ? composerSelection.start : undefined)}</div>}
                  <textarea ref={textareaRef} className={draft ? 'messages-composer-input messages-composer-input--masked' : 'messages-composer-input'} aria-label="消息内容" value={draft} maxLength={2000} rows={1} onFocus={(event) => { setComposerFocused(true); normalizeComposerSelection(event.currentTarget); }} onBlur={() => setComposerFocused(false)} onSelect={(event) => syncComposerSelection(event.currentTarget)} onMouseUp={(event) => { const textarea = event.currentTarget; requestAnimationFrame(() => normalizeComposerSelection(textarea)); }} onChange={(event) => { setDraft(event.target.value); syncComposerSelection(event.currentTarget); }} onPaste={(event) => { const images = clipboardImageFiles(event.clipboardData); if (images.length === 0) return; event.preventDefault(); addImageFiles(images); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; const hasModifier = event.shiftKey || event.metaKey || event.ctrlKey || event.altKey; if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !hasModifier) { const cursor = event.currentTarget.selectionStart ?? 0; const end = event.currentTarget.selectionEnd ?? cursor; if (cursor === end) { const nextCursor = moveXianyuEmojiCursor(event.currentTarget.value, cursor, event.key); if (nextCursor !== cursor) { event.preventDefault(); event.currentTarget.setSelectionRange(nextCursor, nextCursor); syncComposerSelection(event.currentTarget); return; } } } if ((event.key === 'Backspace' || event.key === 'Delete') && !hasModifier) { const result = removeXianyuEmojiMarkerAtCursor(event.currentTarget.value, event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0, event.key); if (result.handled) { event.preventDefault(); setDraft(result.value); setComposerSelection({ start: result.cursor, end: result.cursor }); requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(result.cursor, result.cursor); resizeComposer(); }); return; } } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={MESSAGES_COMPOSER_PLACEHOLDER} />
                </div>
                <div className="messages-composer-footer">
                  <div className="messages-composer-shortcuts">
                    <span>按 Enter 发送 · Shift + Enter 换行</span>
                    <span className={controller.state.sendPhase === 'error' ? 'messages-send-error' : 'messages-send-status'} role={controller.state.sendPhase === 'error' ? 'alert' : undefined}>{controller.state.sendPhase === 'submitting' ? '正在发送…' : controller.state.sendPhase === 'sent' ? '已发送' : controller.state.sendError ?? ''}</span>
                  </div>
                  <button className="messages-send-button" type="submit" disabled={!canSubmitComposer(draft, pendingImages.length > 0) || controller.state.sendPhase === 'submitting'}>
                    <svg className="messages-send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3.5-8L4 4Z" /><path d="M7.5 12H20" /></svg>
                    <span>发送</span>
                  </button>
                </div>
              </div>
            </div>
          </form>
          {(chatImagePreviewUrl || attachmentPreviewUrl) && <div className="messages-image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => { setAttachmentPreviewUrl(null); setChatImagePreviewUrl(null); }}>
            <div className="messages-lightbox-content" onClick={(event) => event.stopPropagation()}>
              <button className="messages-lightbox-close" type="button" aria-label="关闭图片预览" onClick={() => { setAttachmentPreviewUrl(null); setChatImagePreviewUrl(null); }}>×</button>
              <img src={chatImagePreviewUrl ?? attachmentPreviewUrl ?? ''} alt={chatImagePreviewUrl ? '聊天图片大图预览' : '待发送图片大图预览'} />
            </div>
          </div>}
        </> : controller.state.listPhase === 'loading' ? <TimelineSkeleton /> : <div className="messages-state messages-empty-main"><strong>选择一个会话开始查看</strong><span>左侧可以搜索、筛选并选择全部会话。</span></div>}
      </main>
    </div>
  </section>;
}
