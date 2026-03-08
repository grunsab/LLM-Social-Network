import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import './ChatPage.css';

const timeLabel = (ms) => {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const dateTimeLabel = (ms) => {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
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
    ensureConnected,
    createDm,
    createGroup,
    addGroupMember,
    sendMessage,
    setTyping,
    markRead,
  } = useChat();

  const [actionError, setActionError] = useState('');

  const [draftMessage, setDraftMessage] = useState('');
  const [draftDmUserId, setDraftDmUserId] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMemberSelections, setGroupMemberSelections] = useState(() => new Set());
  const [draftAddMemberId, setDraftAddMemberId] = useState('');

  const typingTimeoutRef = useRef(null);

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
    } catch (err) {
      setActionError(err.message || 'Failed to create group chat.');
    }
  };

  const handleAddGroupMember = async () => {
    if (!activeConversationId || !draftAddMemberId) return;
    setActionError('');
    try {
      await addGroupMember(activeConversationId, Number(draftAddMemberId));
      setDraftAddMemberId('');
    } catch (err) {
      setActionError(err.message || 'Failed to add group member.');
    }
  };

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

  return (
    <div className="chat-page">
      <aside className="chat-sidebar card">
        <div className="chat-sidebar-header">
          <h2>Chats</h2>
          <span className={connected ? 'chat-pill online' : 'chat-pill offline'}>
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>

        {loading && <p className="chat-meta">Connecting to realtime chat...</p>}
        {error && <p className="error-message">{error}</p>}

        <div className="chat-quick-actions">
          <h3>Start DM</h3>
          <div className="inline-row">
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
            <button onClick={handleStartDm}>Open</button>
          </div>

          <h3>Create Group</h3>
          <input
            type="text"
            value={groupTitle}
            onChange={(event) => setGroupTitle(event.target.value)}
            placeholder="Group title"
          />
          {friends.length === 0 ? (
            <p className="chat-meta">Add friends first to create a group.</p>
          ) : (
            <>
              <p className="chat-group-helper">Select the friends to include.</p>
              <div className="chat-friend-grid">
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
                <p className="chat-meta">
                  Selected: {selectedGroupMemberNames.join(', ')}
                </p>
              )}
            </>
          )}
          <button onClick={handleCreateGroup}>Create Group</button>
        </div>

        <div className="chat-list">
          {conversations.length === 0 ? (
            <p className="chat-meta">No conversations yet.</p>
          ) : (
            conversations.map((conversation) => {
              const unread = unreadCounts[conversation.conversationId] || 0;
              const isActive = conversation.conversationId === activeConversationId;
              return (
                <button
                  type="button"
                  key={conversation.conversationId}
                  className={`chat-list-item ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveConversationId(conversation.conversationId)}
                >
                  <span className="chat-list-title">{conversation.title || conversation.kind.toUpperCase()}</span>
                  <span className="chat-list-subtitle">
                    {conversation.kind === 'group' ? 'Group' : 'Direct'}
                    {conversation.lastMessageAtMs ? ` · ${timeLabel(conversation.lastMessageAtMs)}` : ''}
                  </span>
                  {unread > 0 && <span className="chat-unread-badge">{unread}</span>}
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="chat-thread card">
        {!activeConversation ? (
          <div className="chat-empty-state">
            <h2>Select a conversation</h2>
            <p>Start with a direct message or create a group from the left panel.</p>
          </div>
        ) : (
          <>
            <header className="chat-thread-header">
              <div>
                <h2>{activeConversation.title || activeConversation.conversationId}</h2>
                <p>
                  {activeConversation.participantUserIds
                    .map((userId) => resolveUsername(userId))
                    .join(', ')}
                </p>
              </div>
              {activeConversation.kind === 'group' && (
                <div className="inline-row">
                  <select
                    value={draftAddMemberId}
                    onChange={(event) => setDraftAddMemberId(event.target.value)}
                  >
                    <option value="">Add member</option>
                    {availableGroupAdditions.map((friend) => (
                      <option key={friend.id} value={friend.id}>
                        {friend.username}
                      </option>
                    ))}
                  </select>
                  <button onClick={handleAddGroupMember}>Add</button>
                </div>
              )}
            </header>

            <div className="chat-messages" role="log" aria-live="polite">
              {activeMessages.length === 0 ? (
                <p className="chat-meta">No messages yet. Send the first encrypted payload.</p>
              ) : (
                activeMessages.map((message, index) => {
                  const isOwnMessage = message.senderUserId === Number(currentUser?.id);
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
                          {senderPresence?.isOnline ? 'Online' : senderPresence ? `Last seen ${dateTimeLabel(senderPresence.lastSeenAtMs)}` : ''}
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
              <input
                type="text"
                value={draftMessage}
                onChange={handleDraftChange}
                placeholder="Type a message"
                autoComplete="off"
              />
              <button type="submit" disabled={!draftMessage.trim()}>Send</button>
            </form>
          </>
        )}
      </section>

      {actionError && (
        <div className="chat-action-error card">
          <p className="error-message">{actionError}</p>
        </div>
      )}
    </div>
  );
}

export default ChatPage;
