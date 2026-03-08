import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

const mockAuthState = vi.hoisted(() => ({
  currentUser: null,
  loading: false,
  logout: vi.fn(),
}));

const mockChatState = vi.hoisted(() => ({
  totalUnread: 0,
}));

vi.mock('./context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('./context/ChatContext', () => ({
  useChat: () => mockChatState,
}));

vi.mock('./components/Dashboard', () => ({
  default: () => <div>Dashboard Mock</div>,
}));

describe('App Component', () => {
  beforeEach(() => {
    mockAuthState.currentUser = null;
    mockAuthState.loading = false;
    mockAuthState.logout.mockReset();
    mockChatState.totalUnread = 0;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unread_count: 0 }),
    });
    window.history.pushState({}, '', '/');
  });

  it('renders Login and Register links when not logged in', () => {
    render(<App />);

    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('link', { name: /socialnet/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /login/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /register/i })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /chat/i })).not.toBeInTheDocument();
  });

  it('renders the chat nav badge for logged-in users with unread messages', () => {
    mockAuthState.currentUser = {
      id: 1,
      username: 'alice',
      email: 'alice@example.com',
    };
    mockChatState.totalUnread = 3;

    render(<App />);

    const nav = screen.getByRole('navigation');
    const chatLink = within(nav).getByRole('link', { name: /chat/i });
    expect(chatLink).toBeInTheDocument();
    expect(within(chatLink).getByText('3')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /logout \(alice\)/i })).toBeInTheDocument();
  });
});
