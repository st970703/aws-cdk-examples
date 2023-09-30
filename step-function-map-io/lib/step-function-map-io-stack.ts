import * as cdk from "aws-cdk-lib";
import {
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { DefinitionBody } from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import { join } from "path";

export class StepFunctionMapIoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Global environment variables

    // Defines the maximum number of lambdas we would like concurrently
    // executing
    const maxLambdaConcurrency = 5 as const;

    // Images bucket
    const imagesBucket = new s3.Bucket(this, "imagesBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(1),
            },
          ],
        },
      ],
    });

    // Batch Lambda
    const batchLambda = new lambda.Function(this, "batchLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(
        join(__dirname, "..", "lambdas", "batch-lambda")
      ),
      handler: "batch_lambda.handler",
      environment: {
        MAX_CONCURENCY: `${maxLambdaConcurrency}`,
      },
    });

    const batchLambdaTask = new tasks.LambdaInvoke(this, "batchLambdaTask", {
      lambdaFunction: batchLambda,
      // Use the entire input
      inputPath: "$",
      // Replace the entire output with the task result
      resultPath: "$",
      payloadResponseOnly: true,
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(2)),
    });

    // Download lambda
    const itemIterator = new sfn.Map(this, "ItemIterator", {
      maxConcurrency: maxLambdaConcurrency,
      itemsPath: "$.Tasks",
    });

    const downloadLambda = new lambda.Function(this, "downloadLambda", {
      runtime: lambda.Runtime.PYTHON_3_11,
      code: lambda.Code.fromAsset(
        join(__dirname, "..", "lambdas", "download-lambda"),
        {
          bundling: {
            image: Runtime.PYTHON_3_11.bundlingImage,
            command: [
              "bash",
              "-c",
              "set -euxo pipefail; pip install -r requirements.in -t /asset-output && cp -au . /asset-output",
            ],
          },
        }
      ),
      handler: "download_lambda.handler",
      environment: {
        IMAGES_BUCKET_NAME: imagesBucket.bucketName,
      },
    });

    // Allows us to save downloaded images to s3
    imagesBucket.grantWrite(downloadLambda);

    const downloadLambdaTask = new tasks.LambdaInvoke(
      this,
      "downloadLambdaTask",
      {
        lambdaFunction: downloadLambda,
        // Use the entire input
        inputPath: "$",
        // Replace the entire task output with the result
        resultPath: "$",
        // Ignore any lambda invocation metadata
        payloadResponseOnly: true,
        taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(3)),
      }
    );

    // Define the statemachine
    const stateMachineDefinition = sfn.Chain.start(batchLambdaTask).next(
      itemIterator.iterator(downloadLambdaTask)
    );

    const mapStateMachineDefinition = new sfn.StateMachine(
      this,
      "DownloadImagesConcurrently",
      {
        definitionBody: DefinitionBody.fromChainable(stateMachineDefinition),
      }
    );
  }
}
