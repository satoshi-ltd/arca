const fs = require('node:fs');
const path = require('node:path');
// React Native 0.83 still ships Foojay 0.5, incompatible with its Gradle 9.
// Upstream fix: https://github.com/reactwg/react-native-releases/issues/1349
const file = path.join(path.dirname(require.resolve('@react-native/gradle-plugin/package.json')), 'settings.gradle.kts');
const source = fs.readFileSync(file, 'utf8');
const old = 'id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0")';
if (source.includes(old)) fs.writeFileSync(file, source.replace(old, 'id("org.gradle.toolchains.foojay-resolver-convention").version("1.0.0")'));
