const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    libraryTarget: 'umd',
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [
    { test: /\.ts$/, use: 'ts-loader' },
    { test: /\.pug$/, use: ['apply-loader', 'pug-loader'] },
    { test: /\.css$/, type: 'asset/source' },
  ] },
  externals: [
    'child_process', 'path', 'fs', 'readline', 'os', /^rxjs/, /^@angular/, /^tabby-/,
  ],
}
