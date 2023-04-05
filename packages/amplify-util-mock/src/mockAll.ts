import { start as startAppSyncServer } from './api';
import { start as startS3Server } from './storage';
import { start as startLambdaServer } from './func';

import { ServiceName as FunctionServiceName } from '@aws-amplify/amplify-category-function';
import { prompter } from '@aws-amplify/amplify-prompts';
import { $TSContext } from 'amplify-cli-core';

const MOCK_SUPPORTED_CATEGORY = ['AppSync', 'S3', FunctionServiceName.LambdaFunction];

export async function mockAllCategories(context: $TSContext): Promise<void> {
  const resources = await context.amplify.getResourceStatus();
  const mockableResources = resources.allResources.filter(
    (resource) => resource.service && MOCK_SUPPORTED_CATEGORY.includes(resource.service),
  );
  const resourceToBePushed = [...resources.resourcesToBeUpdated, ...resources.resourcesToBeCreated].filter(
    (resource) => resource.service && !MOCK_SUPPORTED_CATEGORY.includes(resource.service),
  );
  if (mockableResources.length) {
    if (resourceToBePushed.length) {
      try {
        // push these resources
        context.print.info(
          'Some resources have changed locally and these resources are not mockable. The resources listed below need to be pushed to the cloud before starting the mock server.',
        );
        const didPush = await context.amplify.pushResources(context, undefined, undefined, resourceToBePushed);
        if (!didPush) {
          context.print.info('\n\nMocking may not work as expected since some of the changed resources were not pushed.');
        }
      } catch (e) {
        context.print.info(`Pushing to the cloud failed with the following error \n${e.message}\n\n`);
        const startServer = await await context.amplify.confirmPrompt('Do you still want to start the mock server?');
        if (!startServer) {
          return;
        }
      }
    }
    // Run the mock servers
    const selectedMockableResources = await prompter.pick<'many', string>(
      'Select the category',
      mockableResources.map((r) => r.service).filter((value, index, self) => self.indexOf(value) === index),
      {
        returnSize: 'many',
      },
    );

    const serverPromises = [];
    if (selectedMockableResources.find((service) => service === 'Lambda')) {
      await startLambdaServer(context);
    }
    if (selectedMockableResources.find((service) => service === 'AppSync')) {
      serverPromises.push(startAppSyncServer(context));
    }
    if (selectedMockableResources.find((service) => service === 'S3')) {
      serverPromises.push(startS3Server(context));
    }

    await Promise.all(serverPromises);
  } else {
    context.print.info('No resource in project can be mocked locally.');
  }
}
