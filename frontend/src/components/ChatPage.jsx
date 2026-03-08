import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import './ChatPage.css';

const MOBILE_BREAKPOINT = 980;

const timeLabel = (ms) => {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const dateTimeLabel = (ms) => {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
};

const initialsForLabel = (label) => {
  const parts = String(label || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return '?';
  }

  return parts.map((part) => part[0].toUpperCase()).join('');
};

function ChatPage() {
  const { currentUser } = useAuth();
  const {
    loading,
    connected,
    error,
    chatUserId,
    conversations,
    messagesByConversation,
    typingByConversation,
    readStateByConversation,
    presenceByUserId,
    friends,
    activeConversationId,
    setActiveConversationId,
    unreadCounts,
    totalUnread,
    ensureConnected,
    createDm,
    createGroup,
    addGroupMember,
    sendMessage,
    setTyping,
    markRead,
  } = useChat();

  const currentUserId = currentUser?.id != null ? Number(currentUser.id) : null;

  const [actionError, setActionError] = useState('');
  const [draftMessage, setDraftMessage] = useState('');
  const [draftDmUserId, setDraftDmUserId] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMemberSelections, setGroupMemberSelections] = useState(() => new Set());
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.innerWidth <= MOBILE_BREAKPOINT;
  });
  const [mobilePane, setMobilePane] = useState('list');
  const [isGroupComposerOpen, setIsGroupComposerOpen] = useState(false);
  const [isAddMemberSheetOpen, setIsAddMemberSheetOpen] = useState(false);

  const chatPageRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const messagesViewportRef = useRef(null);
  const composerRef = useRef(null);
  const previousConversationRef = useRef(null);

  useEffect(() => {
    ensureConnected().catch(() => {
      // Connection errors are already surfaced through chat context state.
    });
  }, [ensureConnected]);

  useEffect(() => () => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    const updateViewportState = () => {
      if (typeof window === 'undefined') {
        return;
      }

      setIsMobileLayout(window.innerWidth <= MOBILE_BREAKPOINT);

      if (!chatPageRef.current) {
        return;
      }

      const top = chatPageRef.current.getBoundingClientRect().top;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const nextHeight = Math.max(0, viewportHeight - top - 20);
      chatPageRef.current.style.setProperty('--chat-shell-height', `${nextHeight}px`);
    };

    updateViewportState();
    window.addEventListener('resize', updateViewportState);
    window.visualViewport?.addEventListener('resize', updateViewportState);
    window.visualViewport?.addEventListener('scroll', updateViewportState);

    return () => {
      window.removeEventListener('resize', updateViewportState);
      window.visualViewport?.removeEventListener('resize', updateViewportState);
      window.visualViewport?.removeEventListener('scroll', updateViewportState);
    };
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.conversationId === activeConversationId) || null,
    [activeConversationId, conversations]
  );

  const activeMessages = useMemo(
    () => messagesByConversation[activeConversationId] || [],
    [activeConversationId, messagesByConversation]
  );

  const userLookup = useMemo(() => {
    const lookup = {};
    if (currentUser?.id) {
      lookup[currentUser.id] = {
        id: currentUser.id,
        username: currentUser.username,
        profile_picture: currentUser.profile_picture,
      };
    }
    friends.forEach((friend) => {
      lookup[friend.id] = friend;
    });
    return lookup;
  }, [currentUser, friends]);

  const resolveUsername = (userId) => userLookup[userId]?.username || `User #${userId}`;

  const activeTypingUsers = useMemo(() => {
    const now = Date.now();
    const rows = typingByConversation[activeConversationId] || [];
    return rows
      .filter((row) => row.isTyping && row.userId !== chatUserId && now - row.updatedAtMs < 10000)
      .map((row) => row.userId);
  }, [activeConversationId, chatUserId, typingByConversation]);

  const activeConversationReadState = useMemo(
    () => readStateByConversation[activeConversationId] || {},
    [activeConversationId, readStateByConversation]
  );

  const messageIndexById = useMemo(() => {
    const out = {};
    activeMessages.forEach((message, index) => {
      out[message.messageId] = index;
    });
    return out;
  }, [activeMessages]);

  const conversationPreviews = useMemo(() => {
    const previews = {};

    conversations.forEach((conversation) => {
      const messages = messagesByConversation[conversation.conversationId] || [];
      const lastMessage = messages[messages.length - 1];

      if (!lastMessage) {
        previews[conversation.conversationId] = conversation.kind === 'group'
          ? 'Group chat ready'
          : 'Start the conversation';
        return;
      }

      const senderPrefix = lastMessage.senderUserId === currentUserId
        ? 'You'
        : resolveUsername(lastMessage.senderUserId);
      previews[conversation.conversationId] = `${senderPrefix}: ${lastMessage.ciphertext}`;
    });

    return previews;
  }, [conversations, messagesByConversation, currentUserId, userLookup]);

  const activeConversationSubtitle = useMemo(() => {
    if (!activeConversation) return '';

    if (activeConversation.kind === 'group') {
      const participantCount = activeConversation.participantUserIds.length;
      return participantCount === 1 ? '1 member' : `${participantCount} members`;
    }

    const otherUserIds = activeConversation.participantUserIds.filter((userId) => userId !== currentUserId);
    return otherUserIds.map((userId) => resolveUsername(userId)).join(', ');
  }, [activeConversation, currentUserId, userLookup]);

  const activeConversationStatus = useMemo(() => {
    if (!activeConversation || activeConversation.kind !== 'dm') {
      return '';
    }

    const otherUserId = activeConversation.participantUserIds.find((userId) => userId !== currentUserId);
    if (!otherUserId) {
      return '';
    }

    const otherPresence = presenceByUserId[otherUserId];
    if (otherPresence?.isOnline) {
      return 'Online now';
    }
    if (otherPresence?.lastSeenAtMs) {
      return `Last seen ${dateTimeLabel(otherPresence.lastSeenAtMs)}`;
    }
    return '';
  }, [activeConversation, currentUserId, presenceByUserId]);

  const availableGroupAdditions = useMemo(() => {
    if (!activeConversation) return [];
    const participantIds = new Set(activeConversation.participantUserIds || []);
    return friends.filter((friend) => !participantIds.has(friend.id));
  }, [activeConversation, friends]);

  const selectedGroupMemberNames = useMemo(
    () => friends
      .filter((friend) => groupMemberSelections.has(friend.id))
      .map((friend) => friend.username),
    [friends, groupMemberSelections]
  );

  useEffect(() => {
    if (isMobileLayout && mobilePane === 'thread' && !activeConversationId) {
      setMobilePane('list');
    }
  }, [activeConversationId, isMobileLayout, mobilePane]);

  useEffect(() => {
    if (activeConversation?.kind !== 'group') {
      setIsAddMemberSheetOpen(false);
    }
  }, [activeConversation]);

  useEffect(() => {
    if (!activeConversationId || activeMessages.length === 0) {
      return;
    }
    const lastMessageId = activeMessages[activeMessages.length - 1]?.messageId;
    if (!lastMessageId) return;

    markRead(activeConversationId, lastMessageId).catch((err) => {
      setActionError(err.message || 'Failed to update read state.');
    });
  }, [activeConversationId, activeMessages, markRead]);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) {
      previousConversationRef.current = activeConversationId;
      return;
    }

    const conversationChanged = previousConversationRef.current !== activeConversationId;
    const isNearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
    if (conversationChanged || isNearBottom) {
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: conversationChanged ? 'auto' : 'smooth',
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }

    previousConversationRef.current = activeConversationId;
  }, [activeConversationId, activeMessages]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }

    composer.style.height = '0px';
    const nextHeight = Math.max(44, Math.min(composer.scrollHeight, 140));
    composer.style.height = `${nextHeight}px`;
    composer.style.overflowY = composer.scrollHeight > 140 ? 'auto' : 'hidden';
  }, [draftMessage, activeConversationId]);

  const openConversation = (conversationId) => {
    setActiveConversationId(conversationId);
    if (isMobileLayout) {
      setMobilePane('thread');
    }
  };

  const handleDraftChange = async (event) => {
    const nextValue = event.target.value;
    setDraftMessage(nextValue);

    if (!activeConversationId || !connected) return;

    try {
      await setTyping(activeConversationId, nextValue.trim().length > 0);
    } catch (err) {
      setActionError(err.message || 'Failed to update typing state.');
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    if (nextValue.trim().length > 0) {
      typingTimeoutRef.current = setTimeout(() => {
        setTyping(activeConversationId, false).catch(() => {
          // Ignore best-effort typing cleanup failure.
        });
      }, 1600);
    }
  };

  const handleComposerKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || isMobileLayout) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const handleSend = async (event) => {
    event.preventDefault();
    if (!activeConversationId || !draftMessage.trim()) return;

    try {
      await sendMessage(activeConversationId, draftMessage.trim());
      setDraftMessage('');
      await setTyping(activeConversationId, false);
    } catch (err) {
      setActionError(err.message || 'Failed to send message.');
    }
  };

  const handleStartDm = async () => {
    if (!draftDmUserId) return;
    setActionError('');
    try {
      await createDm(Number(draftDmUserId));
      setDraftDmUserId('');
      if (isMobileLayout) {
        setMobilePane('thread');
      }
    } catch (err) {
      setActionError(err.message || 'Failed to create direct chat.');
    }
  };

  const handleToggleGroupMember = (userId) => {
    setGroupMemberSelections((previous) => {
      const next = new Set(previous);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const handleCreateGroup = async () => {
    if (!groupTitle.trim() || groupMemberSelections.size === 0) return;

    setActionError('');
    try {
      await createGroup(groupTitle.trim(), Array.from(groupMemberSelections));
      setGroupTitle('');
      setGroupMemberSelections(new Set());
      setIsGroupComposerOpen(false);
      if (isMobileLayout) {
        setMobilePane('thread');
      }
    } catch (err) {
      setActionError(err.message || 'Failed to create group chat.');
    }
  };

  const handleAddGroupMember = async (userId) => {
    if (!activeConversationId || !userId) return;
    setActionError('');
    try {
      await addGroupMember(activeConversationId, Number(userId));
      setIsAddMemberSheetOpen(false);
    } catch (err) {
      setActionError(err.message || 'Failed to add group member.');
    }
  };

  const showSidebarPane = !isMobileLayout || mobilePane === 'list';
  const showThreadPane = !isMobileLayout || mobilePane === 'thread';

  const pageClasses = [
    'chat-page',
    isMobileLayout ? `is-mobile-${mobilePane}` : 'is-desktop',
  ].join(' ');

  return (
    <>
      <div ref={chatPageRef} className={pageClasses}>
        {showSidebarPane && (
          <aside className="chat-sidebar card">
            <div className="chat-sidebar-shell">
              <div className="chat-sidebar-header">
                <div className="chat-sidebar-title-block">
                  <h2>Chats</h2>
                  <p>Friends-only realtime messaging.</p>
                </div>
                <div className="chat-sidebar-header-actions">
                  <span className={connected ? 'chat-pill online' : 'chat-pill offline'}>
                    {connected ? 'Live' : 'Offline'}
                  </span>
                  <button
                    type="button"
                    className="chat-secondary-button"
                    onClick={() => setIsGroupComposerOpen(true)}
                    disabled={friends.length === 0}
                  >
                    New Group
                  </button>
                </div>
              </div>

              {(loading || error) && (
                <div className="chat-inline-status">
                  {loading && <p className="chat-meta">Connecting to realtime chat...</p>}
                  {error && <p className="error-message">{error}</p>}
                </div>
              )}

              <div className="chat-dm-launcher">
                <span className="chat-section-label">Start direct message</span>
                <div className="inline-row chat-dm-row">
                  <select
                    value={draftDmUserId}
                    onChange={(event) => setDraftDmUserId(event.target.value)}
                  >
                    <option value="">Select a friend</option>
                    {friends.map((friend) => (
                      <option key={friend.id} value={friend.id}>
                        {friend.username}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={handleStartDm}>Open</button>
                </div>
              </div>

              <div className="chat-list-shell">
                <div className="chat-list-header">
                  <div>
                    <span className="chat-section-label">Recent conversations</span>
                    <p className="chat-list-caption">
                      {totalUnread > 0 ? `${totalUnread} unread` : 'All caught up'}
                    </p>
                  </div>
                </div>

                <div className="chat-list-scroll">
                  <div className="chat-list">
                    {conversations.length === 0 ? (
                      <div className="chat-empty-card">
                        <h3>No conversations yet</h3>
                        <p>Open a DM with a friend or start a group.</p>
                      </div>
                    ) : (
                      conversations.map((conversation) => {
                        const unread = unreadCounts[conversation.conversationId] || 0;
                        const isActive = conversation.conversationId === activeConversationId;
                        const preview = conversationPreviews[conversation.conversationId] || 'No messages yet';
                        const avatarLabel = conversation.title || conversation.kind.toUpperCase();

                        return (
                          <button
                            type="button"
                            key={conversation.conversationId}
                            className={`chat-list-item ${isActive ? 'active' : ''}`}
                            onClick={() => openConversation(conversation.conversationId)}
                          >
                            <span className="chat-avatar chat-list-avatar">
                              {initialsForLabel(avatarLabel)}
                            </span>
                            <span className="chat-list-copy">
                              <span className="chat-list-topline">
                                <span className="chat-list-title">
                                  {conversation.title || conversation.kind.toUpperCase()}
                                </span>
                                <span className="chat-list-time">
                                  {conversation.lastMessageAtMs ? timeLabel(conversation.lastMessageAtMs) : ''}
                                </span>
                              </span>
                              <span className="chat-list-subtitle">{preview}</span>
                            </span>
                            {unread > 0 && <span className="chat-unread-badge">{unread}</span>}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}

        {showThreadPane && (
          <section className="chat-thread card">
            {!activeConversation ? (
              <div className="chat-empty-state">
                <h2>Select a conversation</h2>
                <p>Choose a conversation from the list to start chatting.</p>
              </div>
            ) : (
              <>
                <header className="chat-thread-header">
                  <div className="chat-thread-heading">
                    {isMobileLayout && (
                      <button
                        type="button"
                        className="chat-icon-button chat-back-button"
                        onClick={() => setMobilePane('list')}
                        aria-label="Back to chats"
                      >
                        Back
                      </button>
                    )}
                    <span className="chat-avatar chat-thread-avatar">
                      {initialsForLabel(activeConversation.title || activeConversation.kind.toUpperCase())}
                    </span>
                    <div className="chat-thread-copy">
                      <h2>{activeConversation.title || activeConversation.conversationId}</h2>
                      <p>{activeConversationSubtitle}</p>
                    </div>
                  </div>

                  <div className="chat-thread-actions">
                    {activeConversationStatus && (
                      <span className="chat-thread-status">{activeConversationStatus}</span>
                    )}
                    {activeConversation.kind === 'group' && availableGroupAdditions.length > 0 && (
                      <button
                        type="button"
                        className="chat-secondary-button"
                        onClick={() => setIsAddMemberSheetOpen(true)}
                      >
                        Add Member
                      </button>
                    )}
                  </div>
                </header>

                <div
                  ref={messagesViewportRef}
                  className="chat-messages"
                  role="log"
                  aria-live="polite"
                >
                  {activeMessages.length === 0 ? (
                    <div className="chat-empty-card chat-empty-thread-card">
                      <h3>No messages yet</h3>
                      <p>Say hello to get the conversation started.</p>
                    </div>
                  ) : (
                    activeMessages.map((message, index) => {
                      const isOwnMessage = message.senderUserId === currentUserId;
                      const readByUsernames = (activeConversation.participantUserIds || [])
                        .filter((userId) => userId !== message.senderUserId)
                        .filter((userId) => {
                          const readState = activeConversationReadState[userId];
                          if (!readState?.lastReadMessageId) return false;
                          const readIndex = messageIndexById[readState.lastReadMessageId];
                          return typeof readIndex === 'number' && readIndex >= index;
                        })
                        .map((userId) => resolveUsername(userId));

                      const senderPresence = presenceByUserId[message.senderUserId];

                      return (
                        <article key={message.messageId} className={`chat-message ${isOwnMessage ? 'mine' : 'theirs'}`}>
                          <div className="chat-message-meta">
                            <strong>{isOwnMessage ? 'You' : resolveUsername(message.senderUserId)}</strong>
                            <span>
                              {senderPresence?.isOnline
                                ? 'Online'
                                : senderPresence
                                  ? `Last seen ${dateTimeLabel(senderPresence.lastSeenAtMs)}`
                                  : ''}
                            </span>
                          </div>
                          <p>{message.ciphertext}</p>
                          <footer>
                            <span>{timeLabel(message.createdAtMs)}</span>
                            {readByUsernames.length > 0 && (
                              <span>Read by {readByUsernames.join(', ')}</span>
                            )}
                          </footer>
                        </article>
                      );
                    })
                  )}
                </div>

                {activeTypingUsers.length > 0 && (
                  <p className="chat-typing-indicator">
                    {activeTypingUsers.map((userId) => resolveUsername(userId)).join(', ')} typing...
                  </p>
                )}

                <form className="chat-composer" onSubmit={handleSend}>
                  <textarea
                    ref={composerRef}
                    value={draftMessage}
                    onChange={handleDraftChange}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Type a message"
                    autoComplete="off"
                    rows={1}
                  />
                  <button type="submit" disabled={!draftMessage.trim()}>Send</button>
                </form>
              </>
            )}
          </section>
        )}

        {actionError && (
          <div className="chat-action-error card">
            <p className="error-message">{actionError}</p>
          </div>
        )}
      </div>

      {isGroupComposerOpen && (
        <div
          className="chat-sheet-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsGroupComposerOpen(false);
            }
          }}
        >
          <div
            className="chat-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-group-sheet-title"
          >
            <div className="chat-sheet-header">
              <div>
                <h2 id="chat-group-sheet-title">Create Group</h2>
                <p>Only accepted friends can be added.</p>
              </div>
              <button
                type="button"
                className="chat-secondary-button"
                onClick={() => setIsGroupComposerOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="chat-sheet-body">
              <label className="chat-sheet-field">
                <span className="chat-section-label">Group name</span>
                <input
                  type="text"
                  value={groupTitle}
                  onChange={(event) => setGroupTitle(event.target.value)}
                  placeholder="Weekend plans"
                />
              </label>

              {friends.length === 0 ? (
                <p className="chat-meta">Add friends first to create a group.</p>
              ) : (
                <>
                  <p className="chat-group-helper">Select the friends to include.</p>
                  <div className="chat-sheet-list">
                    {friends.map((friend) => {
                      const isSelected = groupMemberSelections.has(friend.id);
                      return (
                        <button
                          type="button"
                          key={friend.id}
                          className={`chat-member-option ${isSelected ? 'selected' : ''}`}
                          onClick={() => handleToggleGroupMember(friend.id)}
                          aria-pressed={isSelected}
                        >
                          <span className="chat-member-option-name">{friend.username}</span>
                          <span className="chat-member-option-state">
                            {isSelected ? 'Selected' : 'Add'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {selectedGroupMemberNames.length > 0 && (
                    <p className="chat-selected-summary">
                      Selected: {selectedGroupMemberNames.join(', ')}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="chat-sheet-actions">
              <button
                type="button"
                className="chat-secondary-button"
                onClick={() => setIsGroupComposerOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateGroup}
                disabled={!groupTitle.trim() || groupMemberSelections.size === 0}
              >
                Create Group
              </button>
            </div>
          </div>
        </div>
      )}

      {isAddMemberSheetOpen && activeConversation?.kind === 'group' && (
        <div
          className="chat-sheet-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsAddMemberSheetOpen(false);
            }
          }}
        >
          <div
            className="chat-sheet chat-member-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-add-member-sheet-title"
          >
            <div className="chat-sheet-header">
              <div>
                <h2 id="chat-add-member-sheet-title">Add Member</h2>
                <p>Invite another friend into this group.</p>
              </div>
              <button
                type="button"
                className="chat-secondary-button"
                onClick={() => setIsAddMemberSheetOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="chat-sheet-body">
              {availableGroupAdditions.length === 0 ? (
                <p className="chat-meta">No more eligible friends to add.</p>
              ) : (
                <div className="chat-sheet-list">
                  {availableGroupAdditions.map((friend) => (
                    <button
                      type="button"
                      key={friend.id}
                      className="chat-member-option"
                      onClick={() => handleAddGroupMember(friend.id)}
                    >
                      <span className="chat-member-option-name">{friend.username}</span>
                      <span className="chat-member-option-state">Invite</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default ChatPage;
