/**
 * ESM 动态热更新钩子：当父模块带有 ?v=<mtime> 版本查询参数时，
 * 自动将该版本号传播给其所有相对路径子模块导入，确保修改任意 core/*.mjs 均能全链路热重载。
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL &&
    context.parentURL.includes('?v=') &&
    !specifier.includes('?')
  ) {
    const version = context.parentURL.split('?v=')[1];
    return nextResolve(`${specifier}?v=${version}`, context);
  }
  return nextResolve(specifier, context);
}
