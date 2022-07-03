# Code Overview

_This is a brief walkthrough of this project's code and implementation. See [README](README.md) for more about this project._

* [Overall structure](#overall-structure)
* [Local setup](#local-setup)
* [Compute shader](#compute-shader)
  + [Clear pass](#clear-pass)
  + [Pixel order](#pixel-order)
  + [Model view projection matrix](#model-view-projection-matrix)
  + [Compute rasterizer pass](#compute-rasterizer-pass)
    - [Drawing lines instead triangles](#drawing-lines-instead-triangles)
    - [Determining if a point is in a triangle](#determining-if-a-point-is-in-a-triangle)
    - [Shading by depth](#shading-by-depth)
    - [Render pixels closest to the camera](#render-pixels-closest-to-the-camera)
* [Fullscreen quad pass](#fullscreen-quad-pass)
* [Loading models](#loading-models)

## Overall structure

The entry point is in [src/main.js](src/main.js). This creates the WebGPU context, loads a glTF model (see `src/loadModel.js`), and sets up the compute & render passes.

[shaders/computeRasterizer.wgsl](shaders/computeRasterizer.wgsl) contains 2 compute programs:

* A rasterizer program that will run on every triangle to fill it in with shading based on its distance to the camera.
* A clear program that will run on every pixel, to fill the screen buffer with a solid color.

[shaders/fullscreenQuad.wgsl](shaders/fullscreenQuad.wgsl) takes the pixel data generated from the compute pass and copies it to the screen. 

## Local setup

To run the code locally, run `npm install`, then `npm run dev`.

## Compute shader

This is where the bulk of the work happens. In `main.js`, the function `createComputePass` will return:

* `outputColorBuffer`. This is a storage buffer big enough to contain 3 numbers for each pixel on the screen (RGB). Each color is stored as a `uint32`. This holds the output of the compute rasterizer and is given to the fullscreen quad render pass to draw it to the screen. 
* `addComputePass(commandEncoder)`. This is a function that can be called every frame and will push 2 commands:
  * Clear - set all pixels in `outputColorBuffer` to a solid color, white.
  * Rasterizer pass - this runs for every triangle and is responsible for transforming the triangle from world space to screen space, filling it in, shading it based on its distance to the camera, and ensuring triangles closer to the camera are drawn above triangles further away.

### Clear pass

This is the `clear` function in [shaders/computeRasterizer.wgsl](shaders/computeRasterizer.wgsl). Below is the entire function.

```wgsl
@compute @workgroup_size(256, 1)
fn clear(@builtin(global_invocation_id) global_id : vec3<u32>) {
  let index = global_id.x * 3u;

  atomicStore(&outputColorBuffer.values[index + 0u], 255u);
  atomicStore(&outputColorBuffer.values[index + 1u], 255u);
  atomicStore(&outputColorBuffer.values[index + 2u], 255u);
}
```

This colors every pixel as white. We dispatch this shader as many times as there are pixels, with the maximum work group size (256), and so we dispatch it like this in `main.js`:

```javascript
let totalTimesToRun = Math.ceil((WIDTH * HEIGHT) / 256);
passEncoder.setPipeline(clearPipeline);
passEncoder.setBindGroup(0, bindGroup);
passEncoder.dispatch(totalTimesToRun);
```

Note that in the shader, `index` may exceed the actual size of `outputColorBuffer` since we need to round up to the nearest 256 (the workgroup size we picked). It may be good to add a check here to return if the index exceeds the size, but it didn't seem to cause any issues for me. 

We use `atomicStore` here because we defined `outputColorBuffer` as an array of `atomic<u32>` values. We need this to correctly render objects closer to the camera in front as described in the rasterizer section.

_Note: I'm using the same bind group & bind group layout for both the clear pass & rasterizer pass, since they both need to access the same color buffer. But they do not both need to access the vertex buffer or the uniform buffer object. I'm not sure if it is better to have a separate bind group for each._

### Pixel order

I chose to store the pixels in the buffer as a list of rows. So given an X,Y, you can get the correct pixel with the following code. 

```wgsl
let index = (X + Y * screenWidth) * 3u;

let R = f32(colorBuffer.data[index + 0u]) / 255.0;
let G = f32(colorBuffer.data[index + 1u]) / 255.0;
let B = f32(colorBuffer.data[index + 2u]) / 255.0;
```

X and Y are integers giving you the number of pixels offset from the top left origin. This is the logic used by `fullscreenQuad.wgsl` to put the pixels from the color buffer onto the screen.

### Model view projection matrix

We use a model view projection matrix generated using the [glMatrix](https://glmatrix.net/) library. It's created at the beginning of the `addComputePass` function, and sent to the shader as a 4x4 matrix of floats. This approach was taken from the [WebGPU rotating cubes example](https://austin-eng.com/webgpu-samples/samples/rotatingCube).

### Compute rasterizer pass

The rasterizer function is called `main` in [shaders/computeRasterizer.wgsl](shaders/computeRasterizer.wgsl). This is executed for each 3 vertices, so we dispatch this compute shader `vertexCount / 3` times. 

The vertex buffer we supply here is an array of XYZ as floats. So if we were drawing a single triangle it would look like this:

```javascript
const verticesArray = new Float32Array([
	-1, 0, 0, 
	1, 0, 0, 
	0, -1, 0
]);
```

And the compute shader would run 1 time.

The compute rasterizer does the following:

1. Gets the next 3 vertices in world position
2. Projects them to screen position by multiplying by the model view projection matrix
3. Fills in the triangle in screen space using a double for loop, going through every pixel in the bounding box of the triangle, and coloring it if it is inside the triangle.

#### Drawing lines instead triangles

Note the commented out `draw_line` function calls at the end of `main`. You can comment out the draw triangle call and comment these in to draw a wireframe instead:

```wgsl
//draw_triangle(v1, v2, v3);  

draw_line(v1, v2);
draw_line(v2, v3);
draw_line(v1, v3);
```

![](media/model-still.png)

#### Determining if a point is in a triangle

Inside the `draw_triangle` function, we get the min/max of the x,y across the 3 points in the triangle, and we loop over every pixel. If it's inside the triangle, we color it.

Determining if a point is inside the triangle is done using barycentric coordinates. An excellent resource on this is [Lesson 2 - Triangle rasterization and back face culling](https://github.com/ssloy/tinyrenderer/wiki/Lesson-2:-Triangle-rasterization-and-back-face-culling) from Dmitry V. Sokolov's Tiny Renderer project.

Try commenting out this check inside the `draw_triangle` function to skip this check and color every pixel inside the bounding box of the triangle:

```wgsl
if (bc.x < 0.0 || bc.y < 0.0 || bc.z < 0.0) {
  continue;
}
```

![](https://user-images.githubusercontent.com/1711126/145679816-5cd5ed42-16e4-4a36-a6e1-0c578aafe016.png)

#### Shading by depth

Inside the `project` function, I store the `w` component after multiplying by the model view projection matrix, which gives me the depth of this pixel.

```wgsl
var screenPos = uniforms.modelViewProjectionMatrix * vec4<f32>(v.x, v.y, v.z, 1.0);
screenPos.x = (screenPos.x / screenPos.w) * uniforms.screenWidth;
screenPos.y = (screenPos.y / screenPos.w) * uniforms.screenHeight;

return vec3<f32>(screenPos.x, screenPos.y, screenPos.w);
```

This depth is then chosen as the color inside the `draw_triangle` function:

```wgsl
let color = (bc.x * v1.z + bc.y * v2.z + bc.z * v3.z) * 50.0 - 400.0;

let R = color; let G = color; let B = color;
```

This interpolates the depth value across the 3 vertices of the triangle. To get a flat shading look, you can instead just pick one:

```wgsl
let color = v1.z * 50.0 - 400.0;
```

![flat-smooth-shading](https://user-images.githubusercontent.com/1711126/145679726-f5fe2d2f-fbab-4e2f-92fe-e032ef3af2a2.png)

_Note: The multiplication by 50 and offset by 400 here are just arbitrary numbers to scale the depth to look nice for this particular model at this particular distance from the camera._

#### Render pixels closest to the camera

This is the reason the color buffer is created as an array of atomics:

```wgsl
struct ColorBuffer {
  values: array<atomic<u32>>,
};
```

The `color_pixel(x, y, r, g, b)` function essentially generates a depth buffer - it stores the color at the current pixel only if it is smaller than the value currently at that pixel.

This assumes the background color is white, and that pixels closer to the screen are darker. 

Since many threads may be writing to the same pixel at the same time, we use `atomicMin` here to lock the value & compare it with the value we're about to write. 

This means that the current rasterizer cannot draw any other colors while correctly rendering triangles closer to the camera on top of ones behind. 

To extend this, you would:

* Create another storage buffer to hold depth values
* Before coloring a pixel, check if the current depth is smaller than the depth in the buffer (using `atomicLoad` ?)
	* Not sure if this is possible in one pass? Or if it will be required to have a depth pass followed by a color pass
* Write the pixel's depth value into the depth buffer, and the color into the color buffer, if it passes the depth check

## Fullscreen quad pass

This pass happens every frame after the compute pass. It is set up in `main.js` in `createFullscreenPass`. This function similarly returns a `addFullscreenPass(context, commandEncoder)` function that can be called every frame to dispatch this pass.

This pass takes the color buffer and a couple of uniforms. It draws a fullscreen quad using 2 triangles whose vertices are hardcoded in the shader.

## Loading models

Models are loaded in `src/loadModel.js`. This uses the [glTF-transform](https://gltf-transform.donmccurdy.com/) library and only reads in the first primitive of the first mesh of the loaded glTF model. 

It unpacks the positions using the glTF's index buffer since this rasterizer does not currently support index buffers and requires the vertex positions to be a simple list of vertices repeated as needed.
