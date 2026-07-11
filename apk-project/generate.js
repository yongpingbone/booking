// 完全繞過 Bubblewrap CLI 的互動式精靈，直接用 @bubblewrap/core 的底層
// API 產生 Android 專案 + 簽章金鑰。twa-manifest.json 已經是預先產生好、
// 存在 repo 裡的檔案(不是這支腳本產生的)，這支只負責後面兩步：
//   1. 用 twa-manifest.json 產生完整的 Android 專案(含下載圖示，
//      這步需要真的網路連線，所以放在有網路的 GitHub Actions 執行，
//      不是放在產生 twa-manifest.json 的地方一起做)
//   2. 產生簽章金鑰(需要 JDK 17，同樣放在有裝好 JDK 17 的 GitHub Actions
//      執行)
//
// 用這個方式而不是原本的 `bubblewrap init` + expect 自動應答互動精靈，
// 是因為 Bubblewrap 的互動介面(Inquirer.js)在自動化環境下有很多難以
// 完全掌握的重繪/時機問題(細節記在 workflow 檔案跟過去的 commit
// 訊息裡)，直接呼叫底層 API 完全不會有這些問題。

const path = require('path');
const fs = require('fs');
const core = require('@bubblewrap/core');

const targetDirectory = process.cwd();

async function main() {
  const twaManifest = await core.TwaManifest.fromFile(path.join(targetDirectory, 'twa-manifest.json'));

  console.log('=== 讀到的 twa-manifest.json ===');
  console.log(`packageId: ${twaManifest.packageId}`);
  console.log(`host: ${twaManifest.host}`);
  console.log(`name: ${twaManifest.name}`);

  const twaGenerator = new core.TwaGenerator();
  const log = new core.ConsoleLog('Generating TWA');
  await twaGenerator.createTwaProject(targetDirectory, twaManifest, log, () => {});
  console.log('Android 專案產生完成');

  // manifest checksum(bubblewrap update 會用這個判斷 twa-manifest.json
  // 有沒有被手動改過，跟需不需要重新產生專案)
  const manifestContents = fs.readFileSync(path.join(targetDirectory, 'twa-manifest.json'));
  const crypto = require('crypto');
  const sum = crypto.createHash('sha1').update(manifestContents).digest('hex');
  fs.writeFileSync(path.join(targetDirectory, 'manifest-checksum.txt'), sum);
  console.log('manifest-checksum.txt 產生完成');

  // 簽章金鑰——已經存在就跳過(例如之後改用持久化的 keystore，不用每次
  // 重新產生；目前每次都是全新產生，因為 keystore 檔案本身沒有存進 repo)
  const keystorePath = path.join(targetDirectory, twaManifest.signingKey.path);
  if (fs.existsSync(keystorePath)) {
    console.log('簽章金鑰已存在，跳過產生');
  } else {
    const jdkHelper = new core.JdkHelper(process, { jdkPath: process.env.JAVA_HOME });
    const keytool = new core.KeyTool(jdkHelper);
    await keytool.createSigningKey({
      fullName: 'Yongping',
      organizationalUnit: 'Health',
      organization: 'Health',
      country: 'TW',
      password: 'pass1234',
      keypassword: 'pass1234',
      alias: twaManifest.signingKey.alias,
      path: keystorePath,
    });
    console.log('簽章金鑰產生完成');
  }
}

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
