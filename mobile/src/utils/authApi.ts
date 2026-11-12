import { API_BASE_URL } from '../constants'
import { AuthResponse, User } from './types'
import { tokenStorage } from './authStorage'

async function authRequest<T>(path: string, body?: object, method?: string): Promise<T> {
  const token = tokenStorage.get()
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`)
  return payload
}

export interface UpdateProfileBody {
  nickname?: string
  current_password?: string
  new_password?: string
  new_account?: string
  email?: string
  email_clear?: boolean
}

export const authAPI = {
  register: (body: { account: string; password: string; nickname?: string; invite_code?: string; captcha_ticket?: string; captcha_randstr?: string }) =>
    authRequest<AuthResponse>('/auth/register', body),
  login: (body: { account: string; password: string }) =>
    authRequest<AuthResponse>('/auth/login', body),
  me: () => authRequest<User>('/auth/me'),
  updateProfile: (body: UpdateProfileBody) =>
    authRequest<User>('/auth/me', body, 'PATCH'),
  logout: () => authRequest<{ status: string }>('/auth/logout', {}),
  forgotPassword: (account: string) =>
    authRequest<{ status: string; message?: string }>('/auth/forgot-password', { account }),
  resetPassword: (account: string, code: string, newPassword: string) =>
    authRequest<AuthResponse>('/auth/reset-password', { account, code, new_password: newPassword }),
  sendVerifyCode: (account: string) =>
    authRequest<{ status: string; message?: string }>('/auth/send-verify-code', { account }),
  verifyEmail: (account: string, code: string) =>
    authRequest<User>('/auth/verify-email', { account, code }),
}
