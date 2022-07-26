// disabling lint until this file is converted to TS
/* eslint-disable */
const chalk = require('chalk');
const columnify = require('columnify');
const { MultiProgressBar } = require('amplify-prompts');

const COLUMNIFY_WIDTH = 20;

const CFN_SUCCESS_STATUS = ['UPDATE_COMPLETE', 'CREATE_COMPLETE', 'DELETE_COMPLETE', 'DELETE_SKIPPED'];
const CNF_ERROR_STATUS = ['CREATE_FAILED', 'DELETE_FAILED', 'UPDATE_FAILED'];

type ItemPayload = {
  LogicalResourceId: string,
  ResourceType: string,
  ResourceStatus: string,
  Timestamp: string,
}

type ProgressPayload = {
  progressName: string,
  envName: string
}

type EventMap = {
  rootStackName: string,
  envName: string,
  projectName: string,
  rootResources: string[],
  eventToCategories: Map<string, string>,
  categories: {name: string, size: number}[]
}

// Custom Item formatter for progressbar
const createItemFormatter = (payload: ItemPayload) => {
  const e = [{
    logicalResourceId: payload.LogicalResourceId,
    resourceType: payload.ResourceType,
    resourceStatus: payload.ResourceStatus,
    timeStamp: (new Date(payload.Timestamp)).toString(),
  }];

  let output = columnify(e, {
    showHeaders: false,
    truncate: true,
    maxWidth: COLUMNIFY_WIDTH,
    minWidth: COLUMNIFY_WIDTH,
  });

  if(CFN_SUCCESS_STATUS.includes(payload.ResourceStatus)) {
    output = chalk.green(output);
  }
  if (CNF_ERROR_STATUS.includes(payload.ResourceStatus)) {
    output = chalk.red(output);
  }
  return output;
};

// Custom progress bar formatter
const createProgressBarFormatter = (payload : ProgressPayload) => {
  const progressNameParts = payload.progressName.split('-');
  const name = progressNameParts.length === 1 ? progressNameParts[0] : `${progressNameParts[0]} ${progressNameParts[1]}`;
  return `Deploying ${name} on env: ${payload.envName}`;
};

// Initializing the root and individual category bars
const initializeProgressBars = (eventMap : EventMap) => {
  const newMultiBar = new MultiProgressBar({
    progressBarFormatter: createProgressBarFormatter,
    itemFormatter: createItemFormatter,
    loneWolf: false,
    hideCursor: true,
    barSize: 40,
    itemCompleteStatus: CFN_SUCCESS_STATUS,
    itemFailedStatus: CNF_ERROR_STATUS,
    prefixText: 'Deploying Resources into the Cloud. This might take a few minutes ...',
    successText: 'Deployment Successfull ...',
    failureText: 'Deployment Failed ...'
  });

  let progressBarsConfigs = [];
  progressBarsConfigs.push({
    name: 'projectBar',
    value: 0,
    total: 1+eventMap['rootResources'].length,
    payload: {
      progressName: eventMap.projectName,
      envName: eventMap.envName
    }
  });

  progressBarsConfigs = eventMap['categories'].reduce((prev, curr) => {
      return prev.concat({
        name: curr.name,
        value: 0,
        total: curr.size,
        payload: {
          progressName: curr.name,
          envName: eventMap.envName
        }
      })
  }, progressBarsConfigs);

  newMultiBar.create(progressBarsConfigs)
  return newMultiBar
}


module.exports = {
  createItemFormatter,
  createProgressBarFormatter,
  initializeProgressBars
}