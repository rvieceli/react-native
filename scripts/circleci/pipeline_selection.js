/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

/**
 * This script is meant to be used only in CircleCI to compute which tests we should execute
 * based on the files modified by the commit.
 */

const fs = require('fs');
const yargs = require('yargs');
const fetch = require('node-fetch');

/**
 * Check whether the filename is a JS/TS file and not in the script folder
 */
function isJSChange(name) {
  const isJS =
    name.endsWith('.js') ||
    name.endsWith('.jsx') ||
    name.endsWith('.ts') ||
    name.endsWith('.tsx');
  const notAScript = name.indexOf('scripts/') < 0;
  return isJS && notAScript;
}

function isIOS(name) {
  return name.indexOf('React/') > -1 ||
    name.endsWith('.rb') ||
    name.endsWith('.podspec')
}

/**
 * This maps some high level pipelines to some conditions.
 * If those conditions are true, we are going to run the associated pipeline in CI.
 * So, for example, is the commit the CI is analyzing only contains changes in the React/ folder or changes to ruby files
 * the RUN_IOS flag will be turned on and we will run only the CI suite for iOS tests.
 *
 * This mapping is not final and we can update it with more pipelines or we can update the filter condition in the future.
 */
const mapping = [
  {
    name: "RUN_IOS",
    filterFN: name => isIOS(name),
  },
  {
    name: "RUN_ANDROID",
    filterFN: name => name.indexOf('ReactAndroid/') > -1,
  },
  {
    name: "RUN_E2E",
    filterFN: name => name.indexOf('rn-tester-e2e/') > -1,
  },
  {
    name: "RUN_JS",
    filterFN: name => isJSChange(name)
  },
  {
    name: "SKIP",
    filterFN: name => name.endsWith('.md'),
  }
];

const argv = yargs
  .command('create-configs', 'Creates the circleci config from its files', {
    input_path: {
      alias: 'i',
      describe: 'The path to the folder where the Config parts are located',
      default: '.circleci/configurations',
    },
    output_path: {
      alias: 'o',
      describe: 'The path where the `generated_config.yml` will be created',
      default: '.circleci',
    },
    config_file: {
      alias: 'c',
      describe: 'The configuration file with the parameter to set',
      default: '/tmp/circleci/pipeline_config.json',
    },
  })
  .command(
    'filter-jobs',
    'Filters the jobs based on the list of chaged files in the PR',
    {
      github_token: {
        alias: 't',
        describe: 'The token to perform query to github',
        demandOption: true,
      },
      commit_sha: {
        alias: 's',
        describe: 'The SHA of the commit',
        demandOption: 'true',
      },
      username: {
        alias: 'u',
        describe: 'The username of the person creating the PR',
        demandOption: 'true',
      },
      output_path: {
        alias: 'o',
        ddescribe: 'The output path for the configurations',
        default: '/tmp/circleci',
      },
    },
  )
  .demandCommand()
  .strict()
  .help().argv;

// ============== //
//  GITHUB UTILS  //
// ============== //

function _githubHeaders(githubToken, username) {
  return {
    Authorization: `token ${githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': `${username}`,
  };
}

function _queryOptions(githubToken, username) {
  return {
    method: 'GET',
    headers: _githubHeaders(githubToken, username),
  };
}

async function _performRequest(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}\n${response.statusText}`);
  }
  return await response.json();
}

async function _getFilesFromCommit(githubToken, commitSha, username) {
  const url = `https://api.github.com/repos/facebook/react-native/commits/${commitSha}`;
  const options = _queryOptions(githubToken, username);
  const body = await _performRequest(url, options);

  return body.files.map(f => f.filename);
}

async function _computeAndSavePipelineParameters(pipelineType, outputPath) {
  fs.mkdirSync(outputPath, {recursive: true});
  const filePath = `${outputPath}/pipeline_config.json`;

  if (pipelineType === 'SKIP') {
    fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
    return;
  }

  if (pipelineType === 'ALL') {
    fs.writeFileSync(filePath, JSON.stringify({run_all: true}, null, 2));
    return;
  }

  const params = {
    run_all: false,
    run_ios: pipelineType === 'RUN_IOS',
    run_android: pipelineType === 'RUN_ANDROID',
    run_js: pipelineType === 'RUN_JS',
    run_e2e: pipelineType === 'RUN_E2E' || pipelineType === 'RUN_JS',
  };

  fs.writeFileSync(filePath, JSON.stringify(params, null, 2));
}

// ============== //
//    COMMANDS    //
// ============== //

function createConfigs(inputPath, outputPath, configFile) {
  // Order is important!
  const baseConfigFiles = [
    'top_level.yml',
    'executors.yml',
    'commands.yml',
    'jobs.yml',
    'workflows.yml',
  ];

  const baseFolder = 'test_workflows';
  const testConfigs = {
    run_ios: ['testIOS.yml'],
    run_android: ['testAndroid.yml'],
    run_e2e: ['testE2E.yml'],
    run_all: ['testE2E.yml', 'testJS.yml', 'testAll.yml'],
    run_js: ['testJS.yml'],
  };

  if (!fs.existsSync(configFile)) {
    throw new Error(`Config file: ${configFile} does not exists`);
  }

  const jsonParams = JSON.parse(fs.readFileSync(configFile));
  let configurationPartsFiles = baseConfigFiles;

  for (const [key, shouldTest] of Object.entries(jsonParams)) {
    if (shouldTest) {
      const mappedFiles = testConfigs[key].map(f => `${baseFolder}/${f}`);
      configurationPartsFiles = configurationPartsFiles.concat(mappedFiles);
    }
  }
  console.log(configurationPartsFiles);
  let configParts = [];
  configurationPartsFiles.forEach(yamlPart => {
    const fileContent = fs.readFileSync(`${inputPath}/${yamlPart}`);
    configParts.push(fileContent);
  });
  console.info(`writing to: ${outputPath}/generated_config.yml`);
  fs.writeFileSync(
    `${outputPath}/generated_config.yml`,
    configParts.join('\n'),
  );
}

async function filterJobs(githubToken, commitSha, username, outputPath) {
  const fileList = await _getFilesFromCommit(githubToken, commitSha, username);

  for (const filter of mapping) {
    const found = fileList.every(filter.filterFN);
    if (found) {
      await _computeAndSavePipelineParameters(filter.name, outputPath);
      return;
    }
  }
  await _computeAndSavePipelineParameters('ALL', outputPath);
}

async function main() {
  const command = argv._[0];
  if (command === 'create-configs') {
    createConfigs(argv.input_path, argv.output_path, argv.config_file);
  } else if (command === 'filter-jobs') {
    await filterJobs(
      argv.github_token,
      argv.commit_sha,
      argv.username,
      argv.output_path,
    );
  }
}

// ============== //
//      MAIN      //
// ============== //

main();
