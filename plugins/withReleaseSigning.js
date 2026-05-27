const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = '// @release-signing-injected';

function addReleaseSigningConfig(contents) {
  if (contents.includes(MARKER)) return contents;

  const releaseBlock = [
    '',
    '        ' + MARKER,
    '        release {',
    '            def keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")',
    '            if (keystorePath != null && new File(keystorePath).exists()) {',
    '                storeFile file(keystorePath)',
    '                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""',
    '                keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: ""',
    '                keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: ""',
    '            }',
    '        }',
  ].join('\n');

  const before = contents;
  contents = contents.replace(
    /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?keyPassword[^\n]*\n\s*\})/,
    `$1${releaseBlock}`,
  );
  if (contents === before) {
    throw new Error(
      'withReleaseSigning: could not locate signingConfigs.debug block in android/app/build.gradle',
    );
  }

  const mid = contents;
  contents = contents.replace(
    /(\n\s*\/\/ Caution! In production[^\n]*\n\s*\/\/ see [^\n]*\n\s*)signingConfig signingConfigs\.debug/,
    '$1signingConfig (System.getenv("ANDROID_KEYSTORE_PATH") != null ? signingConfigs.release : signingConfigs.debug)',
  );
  if (contents === mid) {
    throw new Error(
      'withReleaseSigning: could not locate release buildType signingConfig in android/app/build.gradle',
    );
  }

  return contents;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') return cfg;
    cfg.modResults.contents = addReleaseSigningConfig(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.addReleaseSigningConfig = addReleaseSigningConfig;
