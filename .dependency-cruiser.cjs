module.exports = {
  forbidden: [
    {
      name: 'no-module-repository-imports',
      comment: 'Modules must only import their public index and shared code.',
      severity: 'error',
      from: { path: '^src/modules/.*' },
      to: { path: '^src/modules/.*/repository(?:\.ts)?$' },
    },
    {
      name: 'no-shared-module-dependence',
      comment: 'Shared code must not depend on business modules.',
      severity: 'error',
      from: { path: '^src/shared/.*' },
      to: { path: '^src/modules/.*' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'dist' },
    tsPreCompilationDeps: true,
    webpackConfig: null,
    reporterOptions: {
      dot: { collapsePattern: 'src/.*' },
    },
  },
};
