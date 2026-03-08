import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Register from './Register';

const mockedNavigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => mockedNavigate,
  };
});

describe('Register Component', () => {
  beforeEach(() => {
    mockedNavigate.mockReset();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderRegister = (initialEntry = '/register') => render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<div>Login Mock</div>} />
      </Routes>
    </MemoryRouter>
  );

  it('renders the registration form', () => {
    renderRegister();

    expect(screen.getByLabelText(/^username:/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email:/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password:/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /login here/i })).toBeInTheDocument();
  });

  it('submits the registration payload and redirects after success', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ message: 'User created successfully', user_id: 123 }),
    });

    renderRegister();

    fireEvent.change(screen.getByLabelText(/^username:/i), {
      target: { value: 'newuser' },
    });
    fireEvent.change(screen.getByLabelText(/^email:/i), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password:/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/v1/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'newuser',
          email: 'new@example.com',
          password: 'password123',
        }),
      });
    });

    expect(
      await screen.findByText('Registration successful! Redirecting to login...')
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^username:/i)).toHaveValue('');
    expect(screen.getByLabelText(/^email:/i)).toHaveValue('');
    expect(screen.getByLabelText(/^password:/i)).toHaveValue('');

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith('/login');
    }, { timeout: 2000 });
    expect(screen.queryByText(/an error occurred during registration/i)).not.toBeInTheDocument();
  });

  it('shows the backend error message when registration fails', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Username already exists' }),
    });

    renderRegister();

    fireEvent.change(screen.getByLabelText(/^username:/i), {
      target: { value: 'existinguser' },
    });
    fireEvent.change(screen.getByLabelText(/^email:/i), {
      target: { value: 'unique@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password:/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register/i }));

    expect(await screen.findByText('Username already exists')).toBeInTheDocument();
    expect(mockedNavigate).not.toHaveBeenCalled();
  });

  it('shows the invite code from the URL and includes it in the request body', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ message: 'User created successfully', user_id: 123 }),
    });

    renderRegister('/register?invite_code=invite-abc');

    expect(screen.getByText(/registering with invite code:/i)).toBeInTheDocument();
    expect(screen.getByText('invite-abc')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^username:/i), {
      target: { value: 'inviteduser' },
    });
    fireEvent.change(screen.getByLabelText(/^email:/i), {
      target: { value: 'invited@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password:/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/v1/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'inviteduser',
          email: 'invited@example.com',
          password: 'password123',
          invite_code: 'invite-abc',
        }),
      });
    });
  });

  it('shows a network error message when registration throws', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));

    renderRegister();

    fireEvent.change(screen.getByLabelText(/^username:/i), {
      target: { value: 'anyuser' },
    });
    fireEvent.change(screen.getByLabelText(/^email:/i), {
      target: { value: 'any@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password:/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register/i }));

    expect(
      await screen.findByText('Failed to connect to the server. Please try again later.')
    ).toBeInTheDocument();
    expect(mockedNavigate).not.toHaveBeenCalled();
  });
});
