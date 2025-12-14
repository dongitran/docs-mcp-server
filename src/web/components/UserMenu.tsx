/**
 * User menu component for authenticated users.
 * Shows user info and logout button when auth is enabled.
 */

interface UserMenuProps {
  /** Whether authentication is enabled */
  authEnabled?: boolean;
}

/**
 * User menu component that fetches user info via Alpine.js
 */
const UserMenu = ({ authEnabled }: UserMenuProps) => {
  if (!authEnabled) {
    return null;
  }

  return (
    <div
      x-data="userMenu()"
      x-init="fetchUser()"
      class="relative"
    >
      {/* User button */}
      <button
        x-show="user"
        x-cloak
        type="button"
        class="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
        x-on:click="open = !open"
      >
        <span class="w-8 h-8 rounded-full bg-primary-500 flex items-center justify-center text-white font-medium text-sm">
          <span x-text="user?.name?.charAt(0) || user?.email?.charAt(0) || '?'"></span>
        </span>
        <span x-text="user?.name || user?.email || 'User'" class="hidden md:inline"></span>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      <div
        x-show="open"
        x-cloak
        x-on:click.away="open = false"
        x-transition:enter="transition ease-out duration-100"
        x-transition:enter-start="transform opacity-0 scale-95"
        x-transition:enter-end="transform opacity-100 scale-100"
        x-transition:leave="transition ease-in duration-75"
        x-transition:leave-start="transform opacity-100 scale-100"
        x-transition:leave-end="transform opacity-0 scale-95"
        class="absolute right-0 mt-2 w-48 rounded-md shadow-lg bg-white dark:bg-gray-700 ring-1 ring-black ring-opacity-5 z-50"
      >
        <div class="py-1">
          <div class="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600">
            <div x-text="user?.email || ''"></div>
          </div>
          <a
            href="/auth/logout"
            class="block px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600"
          >
            Sign out
          </a>
        </div>
      </div>
    </div>
  );
};

export default UserMenu;
