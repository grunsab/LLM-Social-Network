import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Login from './Login';

const mockedNavigate = vi.fn();
const mockLogin = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => mockedNavigate,
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    login: mockLogin,
    currentUser: null,
    loading: false,
    logout: vi.fn(),
  }),
}));

describe('Login Component', () => {
  beforeEach(() => {
    mockedNavigate.mockReset();
    mockLogin.mockReset();
    global.fetch = vi.fn();
  });

  const renderLogin = () => render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>Dashboard Mock</div>} />
      </Routes>
    </MemoryRouter>
  );

  it('renders the login form', () => {
    renderLogin();

    expect(screen.getByLabelText(/username or email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /register here/i })).toBeInTheDocument();
  });

  it('submits credentials and redirects on success', async () => {
    const mockUserData = { id: 1, username: 'testuser', email: 'test@example.com' };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: mockUserData }),
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: 'testuser' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /login/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/v1/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'testuser',
          password: 'password123',
        }),
      });
    });

    expect(mockLogin).toHaveBeenCalledWith(mockUserData);
    expect(mockedNavigate).toHaveBeenCalledWith('/');
    expect(screen.queryByText(/invalid credentials/i)).not.toBeInTheDocument();
  });

  it('shows the backend error message when login fails', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Invalid credentials' }),
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: 'testuser' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'wrongpassword' },
    });
    fireEvent.click(screen.getByRole('button', { name: /login/i }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockedNavigate).not.toHaveBeenCalled();
  });

  it('shows a network error message when the request throws', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));

    renderLogin();

    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: 'testuser' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /login/i }));

    expect(
      await screen.findByText('Failed to connect to the server. Please try again later.')
    ).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
    expect(mockedNavigate).not.toHaveBeenCalled();
  });
});
