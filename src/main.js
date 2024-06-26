import { mat4, vec3, vec4 } from 'gl-matrix';
import '../style.css'
import fullscreenQuadWGSL from '../shaders/fullscreenQuad.wgsl?raw';
import computeRasterizerWGSL from '../shaders/computeRasterizer.wgsl?raw';
import { loadModel } from './loadModel.js';
import { TimingHelper, RollingAverage } from './timing.js';

init();

var canTimestamp = false;
var timingHelper = null;
const fpsAverage = new RollingAverage();
const jsAverage = new RollingAverage();
const gpuAverage = new RollingAverage();

async function init() {
  const adapter = await navigator.gpu.requestAdapter();
  canTimestamp = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
	requiredFeatures: [
		...(canTimestamp ? ['timestamp-query'] : []),
	],
  });
  timingHelper = new TimingHelper(device);
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("webgpu");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const infoElem = document.querySelector('#info');
  let gpuTime = 0;

  const devicePixelRatio = window.devicePixelRatio || 1;
  const presentationSize = [
    Math.floor(canvas.clientWidth * devicePixelRatio),
    Math.floor(canvas.clientHeight * devicePixelRatio),
  ];

  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
    alphaMode: "opaque"
  });

  const verticesArray = await loadModel();

  const { addComputePass, outputColorBuffer } = createComputePass(presentationSize, device, verticesArray);
  const { addFullscreenPass } = createFullscreenPass(presentationFormat, device, presentationSize, outputColorBuffer);

  let then = 0;
  function draw(now) {
	now *= 0.001;  // convert to seconds
    const deltaTime = now - then;
    then = now;
	const startTime = performance.now();

    const commandEncoder = device.createCommandEncoder();

    addComputePass(commandEncoder);
    addFullscreenPass(context, commandEncoder);

	// if (canTimestamp) {
	// 	commandEncoder.resolveQuerySet(perf.querySet, 0, perf.querySet.count, perf.resolveBuffer, 0);
	// 	if (perf.resultBuffer.mapState === 'unmapped') {
	// 		encoder.copyBufferToBuffer(perf.resolveBuffer, 0, perf.resultBuffer, 0, perf.resultBuffer.size);
	// 	}
	// }

    device.queue.submit([commandEncoder.finish()]);

	// if (perf.canTimestamp && perf.resultBuffer.mapState === 'unmapped') {
	// 	perf.resultBuffer.mapAsync(GPUMapMode.READ).then(() => {
	// 		const times = new BigInt64Array(perf.resultBuffer.getMappedRange());
	// 		gpuTime = Number(times[1] - times[0]);
	// 		perf.resultBuffer.unmap();
	// 	});
	// }

	timingHelper.getResult().then(gpuTime => {
        gpuAverage.addSample(gpuTime / 1000000);
    });

	const jsTime = performance.now() - startTime;

    fpsAverage.addSample(1 / deltaTime);
    jsAverage.addSample(jsTime);

    infoElem.textContent = `\
delta: ${deltaTime.toFixed(3)}s
fps: ${fpsAverage.get().toFixed(1)}
js: ${jsAverage.get().toFixed(1)}ms
gpu: ${canTimestamp ? `${gpuAverage.get().toFixed(1)}ms` : 'N/A'}
	`;

    requestAnimationFrame(draw);
  }

  draw();
}

function createFullscreenPass(presentationFormat, device, presentationSize, finalColorBuffer) {
  const fullscreenQuadBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: "uniform"
        }
      }, 
      {
        binding: 1,// the color buffer
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: "read-only-storage"
        }
      }
    ]
  });

  const fullscreenQuadPipeline = device.createRenderPipeline({
    layout:  device.createPipelineLayout({
        bindGroupLayouts: [fullscreenQuadBindGroupLayout]
      }),
    vertex: {
      module: device.createShaderModule({
        code: fullscreenQuadWGSL,
      }),
      entryPoint: 'vert_main',
    },
    fragment: {
      module: device.createShaderModule({
        code: fullscreenQuadWGSL,
      }),
      entryPoint: 'frag_main',
      targets: [
        {
          format: presentationFormat,
        },
      ],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });

  const uniformBufferSize = 4 * 2; // screen width & height
  const uniformBuffer = device.createBuffer({
    size: uniformBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const fullscreenQuadBindGroup = device.createBindGroup({
    layout: fullscreenQuadBindGroupLayout,
    entries: [
      {
        binding: 0, 
        resource: {
          buffer: uniformBuffer
        }
      },
      {
        binding: 1, 
        resource: {
          buffer: finalColorBuffer
        }
      }
    ],
  });

  const renderPassDescriptor = {
    colorAttachments: [
      {
        view: undefined, // Assigned later

        clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ]
  };

  const addFullscreenPass = (context, commandEncoder) => {
     device.queue.writeBuffer(
      uniformBuffer,
      0,
      new Float32Array([presentationSize[0], presentationSize[1]]));

     renderPassDescriptor.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

	  const passEncoder = timingHelper.beginRenderPass(commandEncoder, renderPassDescriptor);
    //   const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
      passEncoder.setPipeline(fullscreenQuadPipeline);
      passEncoder.setBindGroup(0, fullscreenQuadBindGroup);
      passEncoder.draw(6, 1, 0, 0);
      passEncoder.end();
  }

  return { addFullscreenPass };
}

function createComputePass(presentationSize, device, verticesArray) {
  const WIDTH = presentationSize[0];
  const HEIGHT = presentationSize[1];
  const COLOR_CHANNELS = 3;

  const NUMBERS_PER_VERTEX = 3;
  const vertexCount = verticesArray.length / NUMBERS_PER_VERTEX;
  const verticesBuffer = device.createBuffer({
    size: verticesArray.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Float32Array(verticesBuffer.getMappedRange()).set(verticesArray);
  verticesBuffer.unmap();

  const outputColorBufferSize = Uint32Array.BYTES_PER_ELEMENT * (WIDTH * HEIGHT) * COLOR_CHANNELS;
  const outputColorBuffer = device.createBuffer({
    size: outputColorBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });

  const UBOBufferSize =
    4 * 2  + // screen width & height
    4 * 16 + // 4x4 matrix
    8 // extra padding for alignment
  const UBOBuffer = device.createBuffer({
    size: UBOBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE, 
        buffer: {
          type: "storage"
        }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE, 
        buffer: {
          type: "read-only-storage"
        }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "uniform",
        },
      }
    ]
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          buffer: outputColorBuffer
        }
      },
      {
        binding: 1,
        resource: {
          buffer: verticesBuffer
        }
      },
      {
        binding: 2, 
        resource: {
          buffer: UBOBuffer
        }
      }
    ]
  });

  const computeRasterizerModule = device.createShaderModule({  code: computeRasterizerWGSL });
  const rasterizerPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: {  module: computeRasterizerModule, entryPoint: "main" }
  });
  const clearPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: {  module: computeRasterizerModule, entryPoint: "clear" }
  });

  const aspect = WIDTH / HEIGHT;
  const projectionMatrix = mat4.create();
  mat4.perspective(projectionMatrix, (2 * Math.PI) / 5, aspect, 1, 100.0);

  const addComputePass = (commandEncoder) => {
    // Compute model view projection matrix
    const viewMatrix = mat4.create();
    const now = Date.now() / 1000;
    // Move the camera 
    mat4.translate(viewMatrix, viewMatrix, vec3.fromValues(3.5, 2, -10));
    const modelViewProjectionMatrix = mat4.create();
    const modelMatrix = mat4.create();
    // Rotate model over time
    mat4.rotate( modelMatrix, modelMatrix, now, vec3.fromValues(0, 1, 0) );
    // Rotate model 90 degrees so that it is upright
    mat4.rotate( modelMatrix, modelMatrix, Math.PI/2, vec3.fromValues(1, 0, 0) );
    // Combine all into a modelViewProjection
    mat4.multiply(viewMatrix, viewMatrix, modelMatrix);
    mat4.multiply(modelViewProjectionMatrix, projectionMatrix, viewMatrix);

    // Write values to uniform buffer object
    const uniformData = [WIDTH, HEIGHT];
    const uniformTypedArray = new Float32Array(uniformData);
    device.queue.writeBuffer(UBOBuffer, 0, uniformTypedArray.buffer);
    device.queue.writeBuffer(UBOBuffer, 16, modelViewProjectionMatrix.buffer);

    const passEncoder = commandEncoder.beginComputePass();
    let totalTimesToRun = Math.ceil((WIDTH * HEIGHT) / 256);
    // Clear pass
    passEncoder.setPipeline(clearPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(totalTimesToRun);
    // Rasterizer pass
    totalTimesToRun = Math.ceil((vertexCount / 3) / 200);
    passEncoder.setPipeline(rasterizerPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(totalTimesToRun);

    passEncoder.end();
  }

  return { addComputePass, outputColorBuffer };
}
