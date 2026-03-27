/**
 * ECS orchestrator plugin (skeleton).
 * Runs agents as ECS Fargate tasks with EFS for filesystem mounts.
 *
 * TODO: Implement when ECS support is needed.
 *
 * Architecture notes:
 * - Task definition: pre-registered in ECS with the nonnaclaw-agent image in ECR
 * - Mounts: EFS access points per group (replaces Docker bind mounts)
 * - Secrets: AWS Secrets Manager (replaces stdin injection)
 * - Networking: Service discovery or ALB for agent→host MCP bridge
 * - Output: CloudWatch Logs subscription filter for sentinel markers,
 *   or SQS queue for structured output
 * - Cleanup: ECS StopTask API (replaces docker stop)
 */
import { logger } from '../logger.js';
import { SqsIpcTransport } from './ecs-ipc.js';
import type {
  AgentHandle,
  AgentLaunchRequest,
  AgentOutput,
  IpcTransport,
  MountDeclaration,
  NetworkInfo,
  OrchestratorPlugin,
} from './types.js';
import type { RegisteredGroup } from '../types.js';

export class EcsPlugin implements OrchestratorPlugin {
  readonly name = 'ecs';

  private ipcTransport = new SqsIpcTransport();

  async ensureReady(): Promise<void> {
    // TODO: Validate AWS credentials and ECS cluster availability
    // - Check AWS_REGION and AWS_PROFILE/credentials
    // - Verify ECS cluster exists: ecs.DescribeClusters
    // - Verify task definition is registered: ecs.DescribeTaskDefinition
    // - Verify EFS filesystem is available
    throw new Error(
      'ECS plugin not yet implemented. Set NONNACLAW_ORCHESTRATOR=docker or implement ECS support.',
    );
  }

  async cleanupOrphans(): Promise<void> {
    // TODO: List running tasks with nonnaclaw tag, stop stale ones
    // - ecs.ListTasks with family filter
    // - Compare startedAt against threshold
    // - ecs.StopTask for orphans
    logger.warn('ECS cleanupOrphans not yet implemented');
  }

  prepareMounts(
    _group: RegisteredGroup,
    _isMain: boolean,
  ): MountDeclaration[] {
    // TODO: Return EFS mount declarations
    // - Each group gets an EFS access point
    // - Host path becomes EFS path (e.g., fs-12345:/ipc/{group})
    // - Remote path stays the same (/workspace/group, /workspace/ipc, etc.)
    // - Readonly enforcement via IAM policies on access points
    logger.warn('ECS prepareMounts not yet implemented');
    return [];
  }

  async launchAgent(
    _request: AgentLaunchRequest,
    _mounts: MountDeclaration[],
    _onProcess: (handle: AgentHandle) => void,
    _onOutput?: (output: AgentOutput) => Promise<void>,
  ): Promise<AgentOutput> {
    // TODO: Launch ECS Fargate task
    // 1. Build task override with:
    //    - Container overrides for env vars (prompt, sessionId, etc.)
    //    - Secrets from AWS Secrets Manager
    //    - EFS volume mounts from MountDeclaration[]
    // 2. ecs.RunTask with taskDefinition, overrides, networkConfiguration
    // 3. Return handle with task ARN
    // 4. Poll for output via CloudWatch Logs or SQS
    // 5. Return AgentOutput when task completes
    throw new Error('ECS launchAgent not yet implemented');
  }

  async stopAgent(handle: AgentHandle): Promise<void> {
    // TODO: ecs.StopTask({ cluster, task: handle.id, reason: 'Graceful shutdown' })
    logger.warn({ taskArn: handle.id }, 'ECS stopAgent not yet implemented');
  }

  async killAgent(handle: AgentHandle): Promise<void> {
    // TODO: ecs.StopTask with force (same API, ECS doesn't distinguish)
    logger.warn({ taskArn: handle.id }, 'ECS killAgent not yet implemented');
  }

  getNetworkInfo(): NetworkInfo {
    // TODO: Return service discovery endpoint or ALB URL
    // - If using Cloud Map: return service discovery hostname
    // - If using ALB: return ALB DNS name
    return {
      hostAddress: process.env.ECS_HOST_ADDRESS || 'localhost',
    };
  }

  getIpcTransport(): IpcTransport {
    return this.ipcTransport;
  }
}
