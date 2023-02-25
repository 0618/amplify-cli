import { getResourceStatus } from './resource-status';
import { getProviderPlugins } from './get-provider-plugins';
import { $TSContext, toolkitExtensions } from 'amplify-cli-core';

const { getProjectConfig } = toolkitExtensions;

export async function showHelpfulProviderLinks(context: $TSContext) {
  const { providers } = getProjectConfig();
  const providerPlugins = getProviderPlugins(context);
  const providerPromises: (() => Promise<any>)[] = [];

  const { allResources } = await getResourceStatus();

  for (const providerName of providers) {
    const pluginModule = await import(providerPlugins[providerName]);
    providerPromises.push(pluginModule.showHelpfulLinks(context, allResources));
  }

  return Promise.all(providerPromises);
}
