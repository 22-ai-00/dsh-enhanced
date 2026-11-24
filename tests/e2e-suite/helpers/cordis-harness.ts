import { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CordisHarness {
  createContext(): Context
  provideMockService<T>(ctx: Context, name: string, impl: T): void
  mountPlugin<C = unknown>(ctx: Context, plugin: unknown, config?: C): Promise<unknown>
  mountService<T = Record<string, unknown>, C = unknown>(
    ctx: Context,
    plugin: unknown,
    serviceKey: string,
    config?: C,
  ): Promise<T>
  createProfileDir(root: string, profileName: string, patchYaml: string): Promise<string>
  disposeAll(): Promise<void>
}

export function createCordisHarness(): CordisHarness {
  const contexts = new Set<Context>()

  return {
    createContext(): Context {
      const ctx = new Context()
      contexts.add(ctx)
      return ctx
    },

    provideMockService<T>(ctx: Context, name: string, impl: T): void {
      ctx.provide(name as never, impl as never)
    },

    async mountPlugin<C = unknown>(ctx: Context, plugin: unknown, config?: C): Promise<unknown> {
      return ctx.plugin(plugin as never, config as never)
    },

    async mountService<T = Record<string, unknown>, C = unknown>(
      ctx: Context,
      plugin: unknown,
      serviceKey: string,
      config?: C,
    ): Promise<T> {
      await ctx.plugin(plugin as never, config as never)
      const service = ctx.get(serviceKey as never) as T | undefined
      if (service === undefined) {
        throw new Error(`Cordis service "${serviceKey}" was not registered by plugin`)
      }
      return service
    },

    async createProfileDir(root: string, profileName: string, patchYaml: string): Promise<string> {
      const profileDir = join(root, 'profiles', profileName)
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await writeFile(join(profileDir, 'cordis.patch.yml'), patchYaml, 'utf8')
      return profileDir
    },

    async disposeAll(): Promise<void> {
      const active = [...contexts]
      contexts.clear()
      const errors: unknown[] = []
      for (const ctx of active) {
        try {
          await ctx.fiber.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Cordis harness teardown failed')
      }
    },
  }
}
