import {
  FunctionParameters,
  FunctionTemplateCondition,
  FunctionRuntimeCondition,
  FunctionRuntimeParameters,
  FunctionTemplateParameters,
  FunctionRuntimeLifecycleManager,
  RuntimeContributionRequest,
  TemplateContributionRequest,
} from '@aws-amplify/amplify-function-plugin-interface';
import { ServiceName } from './constants';
import _ from 'lodash';
import { LayerParameters } from './layerParams';
import {
  $TSAny,
  $TSContext,
  getPackageManagerByType,
  packageManagers,
  PackageManagerType,
  toPackageManagerInstallArgs,
} from '@aws-amplify/amplify-cli-core';
import { categoryName } from '../../../constants';
import { printer, prompter } from '@aws-amplify/amplify-prompts';
import inquirer from 'inquirer';

/*
 * This file contains the logic for loading, selecting and executing function plugins (currently runtime and template plugins)
 */

/**
 * Selects a function template
 */
export async function templateWalkthrough(context: $TSContext, params: Partial<FunctionParameters>): Promise<FunctionTemplateParameters> {
  const { service } = params.providerContext;
  const selectionOptions: PluginSelectionOptions<FunctionTemplateCondition> = {
    pluginType: 'functionTemplate',
    listOptionsField: 'templates',
    predicate: (condition) => {
      return (
        condition.provider === params.providerContext.provider &&
        condition.services.includes(service) &&
        (condition.runtime === params.runtime.value ||
          (Array.isArray(condition.runtime) && condition.runtime.includes(params.runtime.value)))
      );
    },
    selectionPrompt: 'Choose the function template that you want to use:',
    notFoundMessage: `No ${params.runtime.name} ${params.providerContext.service} templates found`,
    service,
    defaultSelection: params.template,
  };
  const selections = await getSelectionsFromContributors<FunctionTemplateCondition>(context, selectionOptions);
  const selection = selections[0];
  const plugin = await loadPluginFromFactory(selection.pluginPath, 'functionTemplateContributorFactory', context);
  const contributionRequest: TemplateContributionRequest = {
    selection: selection.value,
    contributionContext: {
      runtime: params.runtime,
      functionName: params.functionName,
      resourceName: params.resourceName,
    },
  };
  return await plugin.contribute(contributionRequest);
}

/**
 * Selects a single runtime for a Lambda function
 * Selects one or more runtimes for a Lambda layer
 */
export async function runtimeWalkthrough(
  context: $TSContext,
  params: Partial<FunctionParameters> | Partial<LayerParameters>,
): Promise<Array<Pick<FunctionParameters, 'runtimePluginId'> & FunctionRuntimeParameters>> {
  const { service } = params.providerContext;
  //get the runtimes from template parameters
  let runtimeLayers;
  if (isLayerParameter(params)) {
    runtimeLayers = params.runtimes.map((runtime) => runtime.name);
  }
  const selectionOptions: PluginSelectionOptions<FunctionRuntimeCondition> = {
    pluginType: 'functionRuntime',
    listOptionsField: 'runtimes',
    predicate: (condition) => {
      return condition.provider === params.providerContext.provider && condition.services.includes(service);
    },
    selectionPrompt: 'Choose the runtime that you want to use:',
    notFoundMessage: `No runtimes found for provider ${params.providerContext.provider} and service ${params.providerContext.service}`,
    service,
    runtimeState: runtimeLayers,
    defaultSelection: params.defaultRuntime,
  };
  // runtime selections
  const selections = await getSelectionsFromContributors<FunctionRuntimeCondition>(context, selectionOptions);
  const plugins = [];
  for (const selection of selections) {
    if (selectionOptions.service === ServiceName.LambdaFunction) {
      await packageManagerWalkthrough(selection);
    }

    const plugin = await loadPluginFromFactory(selection.pluginPath, 'functionRuntimeContributorFactory', context);
    const depCheck = await (plugin as FunctionRuntimeLifecycleManager).checkDependencies(selection.value);
    if (!depCheck.hasRequiredDependencies) {
      printer.warn(depCheck.errorMessage || 'Some dependencies required for building and packaging this runtime are not installed');
    }
    plugins.push(plugin);
  }
  return _functionRuntimeWalkthroughHelper(params, plugins, selections);
}

const packageManagerWalkthrough = async (selection: PluginSelection): Promise<void> => {
  if (selection.value === 'nodejs') {
    const packageManagerOptions = Object.values(packageManagers).map((pm) => ({
      name: pm.displayValue,
      value: pm.packageManager as string,
    }));

    packageManagerOptions.push({
      name: 'Custom Build Command or Script Path',
      value: 'custom',
    });

    const packageManager = (await prompter.pick('Choose the package manager that you want to use:', packageManagerOptions)) as
      | PackageManagerType
      | 'custom';

    selection.scripts = {
      build: await getBuildCommand(packageManager),
    };
  }
};

async function _functionRuntimeWalkthroughHelper(
  params: Partial<FunctionParameters> | Partial<LayerParameters>,
  plugins,
  selections,
): Promise<Array<Pick<FunctionParameters, 'runtimePluginId'> & FunctionRuntimeParameters>> {
  const runtimes = [];
  for (let i = 0; i < selections.length && i < plugins.length; ++i) {
    const contributionRequest: RuntimeContributionRequest = {
      selection: selections[i].value,
      contributionContext: {
        functionName: isLayerParameter(params) ? params.layerName : params.functionName,
        resourceName: isLayerParameter(params) ? params.layerName : params.resourceName,
      },
    };
    const contribution = await plugins[i].contribute(contributionRequest);
    runtimes.push({
      ...contribution,
      runtimePluginId: selections[i].pluginId,
      scripts: selections[i].scripts,
    });
  }
  return runtimes;
}

/**
 * Parses plugin metadata to present plugin selections to the user and return the selection.
 */
async function getSelectionsFromContributors<T>(
  context: $TSContext,
  selectionOptions: PluginSelectionOptions<T>,
): Promise<Array<PluginSelection>> {
  const notFoundSuffix = 'You can download and install additional plugins then rerun this command';
  // get providers from context
  const templateProviders = context.pluginPlatform.plugins[selectionOptions.pluginType];
  if (!templateProviders) {
    printer.error(selectionOptions.notFoundMessage);
    printer.error(notFoundSuffix);
    throw new Error('No plugins found for function configuration');
  }

  // load the selections contributed from each provider, constructing a map of selection to provider as we go
  const selectionMap: Map<string, { path: string; pluginId: string }> = new Map();
  const selections = templateProviders
    .filter((meta) => selectionOptions.predicate(meta.manifest[selectionOptions.pluginType].conditions))
    .map((meta) => {
      const packageLoc = meta.packageLocation;
      const pluginId = meta.manifest[selectionOptions.pluginType].pluginId;
      (meta.manifest[selectionOptions.pluginType][selectionOptions.listOptionsField] as ListOption[]).forEach((op) => {
        selectionMap.set(op.value, { path: packageLoc, pluginId });
      });
      return meta;
    })
    .map((meta) => meta.manifest[selectionOptions.pluginType])
    .map((contributes) => contributes[selectionOptions.listOptionsField])
    .reduce((acc, it) => acc.concat(it), [])
    .sort((a, b) => a.name.localeCompare(b.name)); // sort by display name so that selections order is deterministic

  // sanity checks
  let selection;
  if (selections.length === 0) {
    printer.error(selectionOptions.notFoundMessage);
    printer.error(notFoundSuffix);
    throw new Error('Plugins found but no selections supplied for function configuration');
  } else if (selections.length === 1) {
    // quick hack to print custom messages for single selection options
    let singleOptionMsg = `Only one selection option found for ${selectionOptions.listOptionsField}. Using ${selections[0].name} by default`;
    if (selectionOptions.listOptionsField === 'templates') {
      singleOptionMsg = `Only one template found - using ${selections[0].name} by default.`;
    } else if (selectionOptions.listOptionsField === 'runtimes') {
      singleOptionMsg = `Only one runtime detected: ${selections[0].name}. Learn more about additional runtimes at https://docs.amplify.aws/cli/function`;
    }
    printer.info(singleOptionMsg);
    selection = selections[0].value;
  } else if (isDefaultDefined(selectionOptions)) {
    selection = selectionOptions.defaultSelection;
  } else {
    // ask which template to use
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'selection',
        message: selectionOptions.selectionPrompt,
        choices: selections,
        default: defaultSelection(selectionOptions, selections),
      },
    ]);
    selection = answer.selection;
  }

  if (!Array.isArray(selection)) {
    selection = [selection];
  }

  return selection.map((s: string) => {
    return {
      value: s,
      pluginPath: selectionMap.get(s).path,
      pluginId: selectionMap.get(s).pluginId,
    };
  });
}

function isDefaultDefined(selectionOptions: PluginSelectionOptions<FunctionRuntimeCondition>) {
  return (
    selectionOptions.defaultSelection &&
    (selectionOptions.pluginType == 'functionTemplate' || selectionOptions.pluginType == 'functionRuntime')
  );
}

export async function loadPluginFromFactory(pluginPath: string, expectedFactoryFunction: string, context: $TSContext): Promise<$TSAny> {
  let plugin;
  try {
    plugin = await import(pluginPath);
  } catch (err) {
    throw new Error(`Could not load selected plugin. Error is [${err}]`);
  }
  if (!plugin) {
    throw new Error('Could not load selected plugin');
  }
  return plugin[expectedFactoryFunction](context);
}

export async function getRuntimeManager(
  context: $TSContext,
  resourceName: string,
): Promise<FunctionRuntimeLifecycleManager & { runtime: string }> {
  const { pluginId, functionRuntime } = context.amplify.readBreadcrumbs(categoryName, resourceName);
  return {
    ...((await context.amplify.loadRuntimePlugin(context, pluginId)) as FunctionRuntimeLifecycleManager),
    runtime: functionRuntime,
  };
}

// Convenience interfaces that are private to this class

interface PluginSelectionOptions<T extends FunctionRuntimeCondition | FunctionTemplateCondition> {
  pluginType: string;
  predicate: (condition: T) => boolean;
  listOptionsField: string;
  notFoundMessage: string;
  selectionPrompt: string;
  service: string;
  runtimeState?: string[];
  defaultSelection?: string;
}

interface PluginSelection {
  pluginPath: string;
  value: string;
  pluginId: string;
  scripts?: {
    build: string;
  };
}

interface ListOption {
  name: string;
  value: string;
}

function isLayerParameter(params: Partial<LayerParameters> | Partial<FunctionParameters>): params is Partial<LayerParameters> {
  return (params as Partial<LayerParameters>).runtimes !== undefined;
}

function defaultSelection(selectionOptions: PluginSelectionOptions<FunctionRuntimeCondition>, selections) {
  if (selectionOptions.service === ServiceName.LambdaFunction) {
    if (selectionOptions.listOptionsField === 'runtimes') {
      return 'nodejs';
    } else {
      return 'hello-world';
    }
  } else {
    if (selectionOptions.runtimeState !== undefined) {
      return selections
        .filter((selection) => selectionOptions.runtimeState.includes(selection.name))
        .forEach((selection) => _.assign(selection, { checked: true }));
    } else {
      return undefined;
    }
  }
}

const getBuildCommand = async (packageManager: PackageManagerType | 'custom'): Promise<string> => {
  if (packageManager === 'custom') {
    return await inquirer.prompt({
      type: 'input',
      name: 'packageManager',
      message: 'Enter command or script path to build your function:',
    });
  } else {
    const packageManagerInstance = getPackageManagerByType(packageManager);
    return [packageManagerInstance.executable, ...(await toPackageManagerInstallArgs(packageManagerInstance))].join(' ');
  }
};
