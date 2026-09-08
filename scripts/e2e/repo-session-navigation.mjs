import { expect } from '@playwright/test'

export async function selectRestoredSession(page, title) {
  // Hover reveals action buttons and changes the row's accessible name.
  // Match its stable child control, including while the control is hidden.
  const workspaceRow = page.getByRole('treeitem').filter({ has: page.getByRole('button', {
    name: 'Workspace actions for workspace', exact: true, includeHidden: true,
  }) })
  const sessionRow = page.getByRole('treeitem', { name: title, exact: false })
  await expect(async () => {
    await expect(workspaceRow).toHaveAttribute('aria-expanded', /^(true|false)$/, { timeout: 1000 })
    if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
    await expect(sessionRow).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15000 })
  await sessionRow.click()
}
