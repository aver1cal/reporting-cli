/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const { FORMAT, REPORT_TYPE, AUTH, URL_SOURCE } = require('./constants.js');
const exit = require('process');
const ora = require('ora');
const spinner = ora('');

module.exports = async function downloadReport(url, format, width, height, filename, authType, username, password, tenant, multitenancy, time, transport, emailbody, timeout) {
  spinner.start('Connecting to url ' + url);
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--font-render-hinting=none',
        '--enable-features=NetworkService',
        '--ignore-certificate-errors',
        '--single-process'
      ],
      executablePath: process.env.CHROMIUM_PATH,
      ignoreHTTPSErrors: true,
      env: {
        TZ: process.env.TZ || 'UTC',
      },
    });
    const page = await browser.newPage();
    const overridePage = await browser.newPage();
    page.setDefaultNavigationTimeout(0);
    page.setDefaultTimeout(timeout);
    overridePage.setDefaultNavigationTimeout(0);
    overridePage.setDefaultTimeout(timeout);

    // auth 
    if (authType !== undefined && authType !== AUTH.NONE && username !== undefined && password !== undefined) {
      if (authType === AUTH.BASIC) {
        await basicAuthentication(page, overridePage, url, username, password, tenant, multitenancy);
      }
      else if (authType === AUTH.SAML) {
        await samlAuthentication(page, url, username, password, tenant, multitenancy);
      }
      else if (authType === AUTH.COGNITO) {
        await cognitoAuthentication(page, overridePage, url, username, password, tenant, multitenancy);
      }
      else if (authType === AUTH.OPENID) {
        await openidAuthentication(page, url, username, password, tenant, multitenancy);
      }
      spinner.info('Credentials are verified');
    }
    // no auth
    else {
      await page.goto(url, { waitUntil: 'networkidle0' });
    }

    spinner.info('Connected to url ' + url);
    spinner.start('Loading page');
    await page.setViewport({
      width: width,
      height: height,
    });

    const reportSource = getReportSourceFromURL(url);

    // if its an OpenSearch report, remove extra elements.
    if (reportSource !== 'Other' && reportSource !== 'Saved search') {
      await page.evaluate(
        (reportSource, REPORT_TYPE) => {
          // remove buttons.
          document
            .querySelectorAll("[class^='euiButton']")
            .forEach((e) => e.remove());
          // remove top navBar.
          document
            .querySelectorAll("[class^='euiHeader']")
            .forEach((e) => e.remove());
          // remove visualization editor.
          if (reportSource === REPORT_TYPE.VISUALIZATION) {
            document
              .querySelector('[data-test-subj="splitPanelResizer"]')
              ?.remove();
            document.querySelector('.visEditor__collapsibleSidebar')?.remove();
          }
          document.body.style.paddingTop = '0px';
        },
        reportSource,
        REPORT_TYPE
      );
    }

    // force wait for any resize to load after the above DOM modification.
    await new Promise(resolve => setTimeout(resolve, 2000));
    await waitForDynamicContent(page, timeout);
    let buffer;
    spinner.text = `Downloading Report...`;

    // create pdf, png or csv accordingly
    if (format === FORMAT.PDF) {
      const scrollHeight = await page.evaluate(
        () => document.documentElement.scrollHeight
      );

      buffer = await page.pdf({
        margin: undefined,
        width: 1680,
        height: scrollHeight + 'px',
        printBackground: true,
        pageRanges: '1',
      });
    } else if (format === FORMAT.PNG) {
      buffer = await page.screenshot({
        fullPage: true,
      });
    } else if (format === FORMAT.CSV) {
      await page.click('button[id="downloadReport"]');
      await new Promise(resolve => setTimeout(resolve, 1000));
      const is_enabled = await page.evaluate(() => document.querySelector('#generateCSV[disabled]') == null);
      // Check if generateCSV button is enabled.
      if (is_enabled) {
        let catcher = page.waitForResponse(r => r.request().url().includes('/api/reporting/generateReport'));
        page.click('button[id="generateCSV"]');
        let response = await catcher;
        let payload = await response.json();
        buffer = payload.data;
      } else {
        spinner.fail('Please save search and retry');
        process.exit(1);
      }
    }

    const timeCreated = time.valueOf();
    const data = { timeCreated, dataUrl: buffer.toString('base64'), };
    await readStreamToFile(data.dataUrl, filename, format);

    if (transport !== undefined) {
      const emailTemplateImageBuffer = await page.screenshot({
        fullPage: true,
      });
      const data = { timeCreated, dataUrl: emailTemplateImageBuffer.toString('base64'), };
      await readStreamToFile(data.dataUrl, emailbody, FORMAT.PNG);
    }

    await browser.close();
    spinner.succeed('The report is downloaded');
  } catch (e) {
    spinner.fail('Downloading report failed. ' + e);
    process.exit(1);
  }
}

const waitForDynamicContent = async (
  page,
  timeout = timeout,
  interval = 1000,
  checks = 5
) => {
  const maxChecks = timeout / interval;
  let passedChecks = 0;
  let previousLength = 0;

  let i = 0;
  while (i++ <= maxChecks) {
    let pageContent = await page.content();
    let currentLength = pageContent.length;

    previousLength === 0 || previousLength != currentLength
      ? (passedChecks = 0)
      : passedChecks++;
    if (passedChecks >= checks) {
      break;
    }

    previousLength = currentLength;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};

const getReportSourceFromURL = (url) => {
  if (url.includes(URL_SOURCE.DASHBOARDS)) {
    return REPORT_TYPE.DASHBOARD;
  }
  else if (url.includes(URL_SOURCE.VISUALIZE)) {
    return REPORT_TYPE.VISUALIZATION;
  }
  else if (url.includes(URL_SOURCE.DISCOVER) || url.includes(URL_SOURCE.NEW_DISCOVER)) {
    return REPORT_TYPE.DISCOVER;
  }
  else if (url.includes(URL_SOURCE.NOTEBOOKS)) {
    return REPORT_TYPE.NOTEBOOK;
  }
  return REPORT_TYPE.OTHER;
}

const getUrl = async (url) => {
  let urlExt = url.split("#");
  let urlRef = "#" + urlExt[1];
  return urlRef;
};

const basicAuthentication = async (page, overridePage, url, username, password, tenant, multitenancy) => {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise(resolve => setTimeout(resolve, 10000));
  await page.type('input[data-test-subj="user-name"]', username);
  await page.type('[data-test-subj="password"]', password);
  await page.click('button[type=submit]');
  await page.waitForTimeout(10000);
  const tenantSelection = await page.$('Select your tenant');
  try {
    if (multitenancy === true && tenantSelection !== null) {
      if (tenant === 'global' || tenant === 'private') {
        await page.click('label[for=' + tenant + ']');
      } else {
        await page.click('label[for="custom"]');
        await page.click('button[data-test-subj="comboBoxToggleListButton"]');
        await page.type('input[data-test-subj="comboBoxSearchInput"]', tenant);
      }
    } else {
      if ((await page.$('button[type=submit]')) !== null)
        throw new Error('Invalid credentials');
    }
  }
  catch (err) {
    spinner.fail('Invalid username or password');
    exit(1);
  }

  if (multitenancy === true && tenantSelection !== null) {
    await page.waitForTimeout(5000);
    await page.click('button[data-test-subj="confirm"]');
    await page.waitForTimeout(25000);
  }
  await overridePage.goto(url, { waitUntil: 'networkidle0' });
  await overridePage.waitForTimeout(5000);

  if (multitenancy === true  && tenantSelection !== null) {
    // Check if tenant was selected successfully.
    if ((await overridePage.$('button[data-test-subj="confirm"]')) !== null) {
      spinner.fail('Invalid tenant');
      exit(1);
    }
  }
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
};

const samlAuthentication = async (page, url, username, password, tenant, multitenancy) => {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise(resolve => setTimeout(resolve, 10000));
  let refUrl;
  await getUrl(url).then((value) => {
    refUrl = value;
  });
  await page.type('[name="identifier"]', username);
  await page.type('[name="credentials.passcode"]', password);
  await page.click('[value="Sign in"]')
  await page.waitForTimeout(30000);
  const tenantSelection = await page.$('Select your tenant');
  try {
    if (multitenancy === true  && tenantSelection !== null) {
      if (tenant === 'global' || tenant === 'private') {
        await page.click('label[for=' + tenant + ']');
      } else {
        await page.click('label[for="custom"]');
        await page.click('button[data-test-subj="comboBoxToggleListButton"]');
        await page.type('input[data-test-subj="comboBoxSearchInput"]', tenant);
      }
    } else {
      if ((await page.$('[value="Sign in"]')) !== null)
        throw new Error('Invalid credentials');
    }
  }
  catch (err) {
    spinner.fail('Invalid username or password');
    exit(1);
  }
  if (multitenancy === true  && tenantSelection !== null) {
    await page.waitForTimeout(2000);
    await page.click('button[data-test-subj="confirm"]');
    await page.waitForTimeout(25000);
  }
  await page.click(`a[href='${refUrl}']`);
  await page.reload({ waitUntil: 'networkidle0' });
}

const cognitoAuthentication = async (page, overridePage, url, username, password, tenant, multitenancy) => {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise(resolve => setTimeout(resolve, 10000));
  await page.type('[name="username"]', username);
  await page.type('[name="password"]', password);
  await page.click('[name="signInSubmitButton"]');
  await page.waitForTimeout(30000);
  const tenantSelection = await page.$('Select your tenant');
  try {
    if (multitenancy === true  && tenantSelection !== null) {
      if (tenant === 'global' || tenant === 'private') {
        await page.click('label[for=' + tenant + ']');
      } else {
        await page.click('label[for="custom"]');
        await page.click('button[data-test-subj="comboBoxToggleListButton"]');
        await page.type('input[data-test-subj="comboBoxSearchInput"]', tenant);
      }
    } else {
      if ((await page.$('[name="signInSubmitButton"]')) !== null)
        throw new Error('Invalid credentials');
    }
  }
  catch (err) {
    spinner.fail('Invalid username or password');
    exit(1);
  }
  if (multitenancy === true  && tenantSelection !== null) {
    await page.waitForTimeout(2000);
    await page.click('button[data-test-subj="confirm"]');
    await page.waitForTimeout(25000);
  }
  await overridePage.goto(url, { waitUntil: 'networkidle0' });
  await overridePage.waitForTimeout(5000);

  if (multitenancy === true  && tenantSelection !== null) {
    // Check if tenant was selected successfully.
    if ((await overridePage.$('button[data-test-subj="confirm"]')) !== null) {
      spinner.fail('Invalid tenant');
      exit(1);
    }
  }
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
}

const openidAuthentication = async (page, url, username, password, tenant, multitenancy) => {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[name="username"]', {timeout: 20000}).catch(async e => {
    await page.reload({ waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 5000));
  });
  await page.type('[name="username"]', username);
  //check for realms home idp
  await page.waitForSelector('[name="password"]', {timeout: 5000}).catch(async e => {
    await page.click('[name="login"]');
    await new Promise(resolve => setTimeout(resolve, 5000));
  });
  await page.type('[name="password"]', password);
  await page.click('[name="login"]')
  await new Promise(resolve => setTimeout(resolve, 10000));
  await page.goto(url, { waitUntil: 'networkidle0' });
  let tenantSelection = false;
  await page.waitForSelector('Select your tenant', {timeout: 5000}).then(async () => {
    try {
      if (multitenancy === true) {
        tenantSelection = true;
        if (tenant === 'global' || tenant === 'private') {
          await page.click('label[for=' + tenant + ']');
        } else {
          await page.click('label[for="custom"]');
          await page.click('button[data-test-subj="comboBoxToggleListButton"]');
          await page.type('input[data-test-subj="comboBoxSearchInput"]', tenant);
        }
      } else {
        if ((await page.$('[name="login"]')) !== null)
          throw new Error('Invalid credentials');
      }
    }
    catch (err) {
      spinner.fail('Invalid username or password');
      exit(1);
    }
  }).catch(async e => {
    //no tenant selection
  });
  
  if (multitenancy === true && tenantSelection) {
    await page.waitForTimeout(5000);
    await page.click('button[data-test-subj="confirm"]');
    await page.waitForTimeout(25000);
  }
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
}

const readStreamToFile = async (
  stream,
  filename,
  format
) => {
  if (fs.existsSync(filename)) {
    spinner.fail('File with same name already exists.');
    exit(1);
  }
  if (format === FORMAT.PDF || format === FORMAT.PNG) {
    let base64Image = stream.split(';base64,').pop();
    fs.writeFile(filename, base64Image, { encoding: 'base64' }, function (err) {
      if (err) throw err;
    })
  } else {
    fs.writeFile(filename, stream, function (err) {
      if (err) throw err;
    })
  }
};
