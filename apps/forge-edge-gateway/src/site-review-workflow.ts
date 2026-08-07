import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { executeSiteReview } from './site-review';

export class SiteReviewWorkflow extends WorkflowEntrypoint<Env, { reviewId: string }> {
  override async run(event: Readonly<WorkflowEvent<{ reviewId: string }>>, step: WorkflowStep): Promise<{ reviewId: string; state: string }> {
    const result = await step.do(
      'run public site review',
      { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
      async () => ({ state: (await executeSiteReview(this.env, event.payload.reviewId)).state })
    );
    return { reviewId: event.payload.reviewId, state: result.state };
  }
}
