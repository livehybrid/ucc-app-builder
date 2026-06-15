/* eslint-disable */
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const APP_ID = 'data_dictionary';
const STAGE = path.join(__dirname, 'stage');
const UCC_OUTPUT = path.join(__dirname, 'build', APP_ID);

module.exports = {
    mode: 'production',
    entry: {
        concierge: path.join(__dirname, 'src/main/webapp/pages/concierge/index.jsx'),
    },
    output: {
        path: path.join(STAGE, 'appserver', 'static', 'pages'),
        filename: '[name].js',
        publicPath: `/static/app/${APP_ID}/pages/`,
        clean: false,
    },
    resolve: {
        extensions: ['.js', '.jsx'],
    },
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            ['@babel/preset-env', { targets: { browsers: ['last 2 versions'] } }],
                            ['@babel/preset-react', { runtime: 'classic' }],
                        ],
                    },
                },
            },
        ],
    },
    plugins: [
        // Copy the UCC build output (conf, bin, lookups, appserver templates,
        // app.manifest, default/) into stage/ so stage/ is a complete app.
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: UCC_OUTPUT,
                    to: STAGE,
                    noErrorOnMissing: true,
                    globOptions: { ignore: ['**/appserver/static/pages/**'] },
                },
            ],
        }),
    ],
};
