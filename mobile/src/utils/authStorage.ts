import { Platform } from 'react-native'

let nativeToken: string | null = null

export const tokenStorage = {
  get(): string | null {
    if (Platform.OS === 'web') return sessionStorage.getItem('auth_token')
    return nativeToken
  },
  set(token: string) {
    if (Platform.OS === 'web') sessionStorage.setItem('auth_token', token)
    else nativeToken = token
  },
  clear() {
    if (Platform.OS === 'web') sessionStorage.removeItem('auth_token')
    else nativeToken = null
  },
}
