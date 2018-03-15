define([
        '../Core/AttributeCompression',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Math',
        '../Core/Check',
        '../Core/Color',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/deprecationWarning',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/FeatureDetection',
        '../Core/Intersect',
        '../Core/Matrix4',
        '../Core/PixelFormat',
        '../Core/Plane',
        '../Renderer/ContextLimits',
        '../Renderer/PixelDatatype',
        '../Renderer/Sampler',
        '../Renderer/Texture',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureWrap',
        './ClippingPlane'
    ], function(
        AttributeCompression,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        CesiumMath,
        Check,
        Color,
        defaultValue,
        defined,
        defineProperties,
        deprecationWarning,
        destroyObject,
        DeveloperError,
        FeatureDetection,
        Intersect,
        Matrix4,
        PixelFormat,
        Plane,
        ContextLimits,
        PixelDatatype,
        Sampler,
        Texture,
        TextureMagnificationFilter,
        TextureMinificationFilter,
        TextureWrap,
        ClippingPlane) {
    'use strict';

    /**
     * Specifies a set of clipping planes. Clipping planes selectively disable rendering in a region on the
     * outside of the specified list of {@link ClippingPlane} objects for a single gltf model, 3D Tileset, or the globe.
     *
     * @alias ClippingPlaneCollection
     * @constructor
     *
     * @param {Object} [options] Object with the following properties:
     * @param {ClippingPlane[]} [options.planes=[]] An array of {@link ClippingPlane} objects used to selectively disable rendering on the outside of each plane.
     * @param {Boolean} [options.enabled=true] Determines whether the clipping planes are active.
     * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] The 4x4 transformation matrix specifying an additional transform relative to the clipping planes original coordinate system.
     * @param {Boolean} [options.unionClippingRegions=false] If true, a region will be clipped if included in any plane in the collection. Otherwise, the region to be clipped must intersect the regions defined by all planes in this collection.
     * @param {Color} [options.edgeColor=Color.WHITE] The color applied to highlight the edge along which an object is clipped.
     * @param {Number} [options.edgeWidth=0.0] The width, in pixels, of the highlight applied to the edge along which an object is clipped.
     */
    function ClippingPlaneCollection(options) {
        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        this._planes = [];
        this._containsUntrackablePlanes = false;

        // Do partial texture updates if just one plane is dirty.
        // If many planes are dirty, refresh the entire texture.
        this._dirtyIndex = -1;
        this._multipleDirtyPlanes = false;

        // Add each plane to check if it's actually a Plane object instead of a ClippingPlane.
        // Use of Plane objects will be deprecated.
        var planes = options.planes;
        if (defined(planes)) {
            var planesLength = planes.length;
            for (var i = 0; i < planesLength; ++i) {
                this.add(planes[i]);
            }
        }

        this._enabled = defaultValue(options.enabled, true);

        /**
         * The 4x4 transformation matrix specifying an additional transform relative to the clipping planes
         * original coordinate system.
         *
         * @type {Matrix4}
         * @default Matrix4.IDENTITY
         */
        this.modelMatrix = Matrix4.clone(defaultValue(options.modelMatrix, Matrix4.IDENTITY));

        /**
         * The color applied to highlight the edge along which an object is clipped.
         *
         * @type {Color}
         * @default Color.WHITE
         */
        this.edgeColor = Color.clone(defaultValue(options.edgeColor, Color.WHITE));

        /**
         * The width, in pixels, of the highlight applied to the edge along which an object is clipped.
         *
         * @type {Number}
         * @default 0.0
         */
        this.edgeWidth = defaultValue(options.edgeWidth, 0.0);

        // If this ClippingPlaneCollection has an owner, only its owner should update or destroy it.
        // This is because in a Cesium3DTileset multiple models may reference the tileset's ClippingPlaneCollection.
        this._owner = undefined;

        var unionClippingRegions = defaultValue(options.unionClippingRegions, false);
        this._unionClippingRegions = unionClippingRegions;
        this._testIntersection = unionClippingRegions ? unionIntersectFunction : defaultIntersectFunction;

        this._uint8View = undefined;
        this._float32View = undefined;

        this._clippingPlanesTexture = undefined;
    }

    function unionIntersectFunction(value) {
        return (value === Intersect.OUTSIDE);
    }

    function defaultIntersectFunction(value) {
        return (value === Intersect.INSIDE);
    }

    defineProperties(ClippingPlaneCollection.prototype, {
        /**
         * Returns the number of planes in this collection.  This is commonly used with
         * {@link ClippingPlaneCollection#get} to iterate over all the planes
         * in the collection.
         *
         * @memberof ClippingPlaneCollection.prototype
         * @type {Number}
         * @readonly
         */
        length : {
            get : function() {
                return this._planes.length;
            }
        },

        /**
         * If true, a region will be clipped if included in any plane in the collection. Otherwise, the region
         * to be clipped must intersect the regions defined by all planes in this collection.
         *
         * @memberof ClippingPlaneCollection.prototype
         * @type {Boolean}
         * @default false
         */
        unionClippingRegions : {
            get : function() {
                return this._unionClippingRegions;
            },
            set : function(value) {
                if (this._unionClippingRegions === value) {
                    return;
                }
                this._unionClippingRegions = value;
                this._testIntersection = value ? unionIntersectFunction : defaultIntersectFunction;
            }
        },

        /**
         * If true, clipping will be enabled.
         *
         * @memberof ClippingPlaneCollection.prototype
         * @type {Boolean}
         * @default true
         */
        enabled : {
            get : function() {
                return this._enabled;
            },
            set : function(value) {
                if (this._enabled === value) {
                    return;
                }
                this._enabled = value;
            }
        },

        /**
         * Returns a texture containing packed, untransformed clipping planes.
         *
         * @memberof ClippingPlaneCollection.prototype
         * @type {Texture}
         * @readonly
         * @private
         */
        texture : {
            get : function() {
                return this._clippingPlanesTexture;
            }
        },

        /**
         * A reference to the ClippingPlaneCollection's owner, if any.
         *
         * @memberof ClippingPlaneCollection.prototype
         * @readonly
         * @private
         */
        owner : {
            get : function() {
                return this._owner;
            }
        },

        /**
         * Returns a Number encapsulating the state for this ClippingPlaneCollection.
         *
         * Clipping mode is encoded in the sign of the number, which is just the plane count.
         * Used for checking if shader regeneration is necessary.
         *
         * @memberof ClippingPlaneCollection.prototype
         * @returns {Number} A Number that describes the ClippingPlaneCollection's state.
         * @readonly
         * @private
         */
        clippingPlanesState : {
            get : function() {
                return this._unionClippingRegions ? this._planes.length : -this._planes.length;
            }
        }
    });

    function setIndexDirty(collection, index) {
        // If there's already a different _dirtyIndex set, more than one plane has changed since update.
        // Entire texture must be reloaded
        collection._multipleDirtyPlanes = collection._multipleDirtyPlanes || (collection._dirtyIndex !== -1 && collection._dirtyIndex !== index);
        collection._dirtyIndex = index;
    }

    /**
     * Adds the specified {@link ClippingPlane} to the collection to be used to selectively disable rendering
     * on the outside of each plane. Use {@link ClippingPlaneCollection#unionClippingRegions} to modify
     * how modify the clipping behavior of multiple planes.
     *
     * @param {ClippingPlane} plane The ClippingPlane to add to the collection.
     *
     * @see ClippingPlaneCollection#unionClippingRegions
     * @see ClippingPlaneCollection#remove
     * @see ClippingPlaneCollection#removeAll
     */
    ClippingPlaneCollection.prototype.add = function(plane) {
        var newPlaneIndex = this._planes.length;
        if (plane instanceof ClippingPlane) {
            var that = this;
            plane.onChangeCallback = function(index) {
                setIndexDirty(that, index);
            };
            plane.index = newPlaneIndex;
        } else {
            deprecationWarning('ClippingPlaneCollection.add', 'Ability to use Plane objects with ClippingPlaneCollection.add is deprecated and will be removed in Cesium 1.45. Please use ClippingPlane objects instead.');
            this._containsUntrackablePlanes = true;
        }
        setIndexDirty(this, newPlaneIndex);
        this._planes.push(plane);
    };

    /**
     * Returns the plane in the collection at the specified index.  Indices are zero-based
     * and increase as planes are added.  Removing a plane shifts all planes after
     * it to the left, changing their indices.  This function is commonly used with
     * {@link ClippingPlaneCollection#length} to iterate over all the planes
     * in the collection.
     *
     * @param {Number} index The zero-based index of the plane.
     * @returns {ClippingPlane} The ClippingPlane at the specified index.
     *
     * @see ClippingPlaneCollection#length
     */
    ClippingPlaneCollection.prototype.get = function(index) {
        //>>includeStart('debug', pragmas.debug);
        Check.typeOf.number('index', index);
        //>>includeEnd('debug');

        return this._planes[index];
    };

    function indexOf(planes, plane) {
        var length = planes.length;
        for (var i = 0; i < length; ++i) {
            if (Plane.equals(planes[i], plane)) {
                return i;
            }
        }

        return -1;
    }

    /**
     * Checks whether this collection contains a ClippingPlane equal to the given ClippingPlane.
     *
     * @param {ClippingPlane} [clippingPlane] The ClippingPlane to check for.
     * @returns {Boolean} true if this collection contains the ClippingPlane, false otherwise.
     *
     * @see ClippingPlaneCollection#get
     */
    ClippingPlaneCollection.prototype.contains = function(clippingPlane) {
        return indexOf(this._planes, clippingPlane) !== -1;
    };

    /**
     * Removes the first occurrence of the given ClippingPlane from the collection.
     *
     * @param {ClippingPlane} clippingPlane
     * @returns {Boolean} <code>true</code> if the plane was removed; <code>false</code> if the plane was not found in the collection.
     *
     * @see ClippingPlaneCollection#add
     * @see ClippingPlaneCollection#contains
     * @see ClippingPlaneCollection#removeAll
     */
    ClippingPlaneCollection.prototype.remove = function(clippingPlane) {
        var planes = this._planes;
        var index = indexOf(planes, clippingPlane);

        if (index === -1) {
            return false;
        }

        // Unlink this ClippingPlaneCollection from the ClippingPlane
        if (clippingPlane instanceof ClippingPlane) {
            clippingPlane.onChangeCallback = undefined;
            clippingPlane.index = -1;
        }

        // Shift and update indices
        var length = planes.length - 1;
        for (var i = index; i < length; ++i) {
            var planeToKeep = planes[i + 1];
            planes[i] = planeToKeep;
            if (planeToKeep instanceof ClippingPlane) {
                planeToKeep.index = i;
            }
        }

        // Indicate planes texture is dirty
        this._multipleDirtyPlanes = true;
        planes.length = length;

        return true;
    };

    /**
     * Removes all planes from the collection.
     *
     * @see ClippingPlaneCollection#add
     * @see ClippingPlaneCollection#remove
     */
    ClippingPlaneCollection.prototype.removeAll = function() {
        // Dereference this ClippingPlaneCollection from all ClippingPlanes
        var planes = this._planes;
        var planesCount = planes.length;
        for (var i = 0; i < planesCount; ++i) {
            var plane = planes[i];
            if (plane instanceof ClippingPlane) {
                plane.onChangeCallback = undefined;
                plane.index = -1;
            }
        }
        this._multipleDirtyPlanes = true;
        this._planes = [];
    };

    var distanceEncodeScratch = new Cartesian4();
    var oct32EncodeScratch = new Cartesian4();
    function packPlanesAsUint8(clippingPlaneCollection, startIndex, endIndex) {
        var uint8View = clippingPlaneCollection._uint8View;
        var planes = clippingPlaneCollection._planes;
        var byteIndex = 0;
        for (var i = startIndex; i < endIndex; ++i) {
            var plane = planes[i];

            var oct32Normal = AttributeCompression.octEncodeToCartesian4(plane.normal, oct32EncodeScratch);
            uint8View[byteIndex] = oct32Normal.x;
            uint8View[byteIndex + 1] = oct32Normal.y;
            uint8View[byteIndex + 2] = oct32Normal.z;
            uint8View[byteIndex + 3] = oct32Normal.w;

            var encodedDistance = Cartesian4.packFloat(plane.distance, distanceEncodeScratch);
            uint8View[byteIndex + 4] = encodedDistance.x;
            uint8View[byteIndex + 5] = encodedDistance.y;
            uint8View[byteIndex + 6] = encodedDistance.z;
            uint8View[byteIndex + 7] = encodedDistance.w;

            byteIndex += 8;
        }
    }

    // Pack starting at the beginning of the buffer to allow partial update
    function packPlanesAsFloats(clippingPlaneCollection, startIndex, endIndex) {
        var float32View = clippingPlaneCollection._float32View;
        var planes = clippingPlaneCollection._planes;

        var floatIndex = 0;
        for (var i = startIndex; i < endIndex; ++i) {
            var plane = planes[i];
            var normal = plane.normal;

            float32View[floatIndex] = normal.x;
            float32View[floatIndex + 1] = normal.y;
            float32View[floatIndex + 2] = normal.z;
            float32View[floatIndex + 3] = plane.distance;

            floatIndex += 4; // each plane is 4 floats
        }
    }

    function computeTextureResolution(pixelsNeeded, result) {
        var maxSize = ContextLimits.maximumTextureSize;
        var width = Math.min(pixelsNeeded, maxSize);
        var height = Math.ceil(pixelsNeeded / width);
        result.x = Math.max(width, 1);
        result.y = Math.max(height, 1);
        return result;
    }

    var textureResolutionScratch = new Cartesian2();
    /**
     * Called when {@link Viewer} or {@link CesiumWidget} render the scene to
     * build the resources for clipping planes.
     * <p>
     * Do not call this function directly.
     * </p>
     */
    ClippingPlaneCollection.prototype.update = function(frameState) {
        var clippingPlanesTexture = this._clippingPlanesTexture;
        var context = frameState.context;
        var useFloatTexture = ClippingPlaneCollection.useFloatTexture(context);

        // Compute texture requirements for current planes
        // In RGBA FLOAT, A plane is 4 floats packed to a RGBA.
        // In RGBA UNSIGNED_BYTE, A plane is a float in [0, 1) packed to RGBA and an Oct32 quantized normal,
        // so 8 bits or 2 pixels in RGBA.
        var pixelsNeeded = useFloatTexture ? this.length : this.length * 2;
        var requiredResolution = computeTextureResolution(pixelsNeeded, textureResolutionScratch);

        if (defined(clippingPlanesTexture)) {
            var currentPixelCount = clippingPlanesTexture.width * clippingPlanesTexture.height;
            // Recreate the texture to double current requirement if it isn't big enough or is 4 times larger than it needs to be.
            // Optimization note: this isn't exactly the classic resizeable array algorithm
            // * not necessarily checking for resize after each add/remove operation
            // * random-access deletes instead of just pops
            // * alloc ops likely more expensive than demonstrable via big-O analysis
            if (currentPixelCount < pixelsNeeded ||
                pixelsNeeded < 0.25 * currentPixelCount) {
                    clippingPlanesTexture.destroy();
                    clippingPlanesTexture = undefined;
                }
        }

        if (!defined(clippingPlanesTexture)) {
            // Allocate twice as much space as needed to avoid frequent texture reallocation.
            requiredResolution.x *= 2;

            var sampler = new Sampler({
                wrapS : TextureWrap.CLAMP_TO_EDGE,
                wrapT : TextureWrap.CLAMP_TO_EDGE,
                minificationFilter : TextureMinificationFilter.NEAREST,
                magnificationFilter : TextureMagnificationFilter.NEAREST
            });

            if (useFloatTexture) {
                clippingPlanesTexture = new Texture({
                    context : context,
                    width : requiredResolution.x,
                    height : requiredResolution.y,
                    pixelFormat : PixelFormat.RGBA,
                    pixelDatatype : PixelDatatype.FLOAT,
                    sampler : sampler,
                    flipY : false
                });
                this._float32View = new Float32Array(requiredResolution.x * requiredResolution.y * 4);
            } else {
                clippingPlanesTexture = new Texture({
                    context : context,
                    width : requiredResolution.x,
                    height : requiredResolution.y,
                    pixelFormat : PixelFormat.RGBA,
                    pixelDatatype : PixelDatatype.UNSIGNED_BYTE,
                    sampler : sampler,
                    flipY : false
                });
                this._uint8View = new Uint8Array(requiredResolution.x * requiredResolution.y * 4);
            }

            this._clippingPlanesTexture = clippingPlanesTexture;
            this._multipleDirtyPlanes = true;
        }

        // Use of Plane objects will be deprecated.
        // But until then, we have no way of telling if they changed since last frame, so we have to do a full udpate.
        var refreshFullTexture = this._multipleDirtyPlanes || this._containsUntrackablePlanes;
        var dirtyIndex = this._dirtyIndex;

        if (!refreshFullTexture && dirtyIndex === -1) {
            return;
        }

        if (!refreshFullTexture) {
            // partial updates possible
            var offsetY = Math.floor(dirtyIndex / clippingPlanesTexture.width);
            var offsetX = Math.floor(dirtyIndex - offsetY * clippingPlanesTexture.width);
            if (useFloatTexture) {
                packPlanesAsFloats(this, dirtyIndex, dirtyIndex + 1);
                clippingPlanesTexture.copyFrom({
                    width : 1,
                    height : 1,
                    arrayBufferView : this._float32View
                }, offsetX, offsetY);
            } else {
                packPlanesAsUint8(this, dirtyIndex, dirtyIndex + 1);
                clippingPlanesTexture.copyFrom({
                    width : 2,
                    height : 1,
                    arrayBufferView : this._uint8View
                }, offsetX, offsetY);
            }
        } else if (useFloatTexture) {
            packPlanesAsFloats(this, 0, this._planes.length);
            clippingPlanesTexture.copyFrom({
                width : clippingPlanesTexture.width,
                height : clippingPlanesTexture.height,
                arrayBufferView : this._float32View
            });
        } else {
            packPlanesAsUint8(this, 0, this._planes.length);
            clippingPlanesTexture.copyFrom({
                width : clippingPlanesTexture.width,
                height : clippingPlanesTexture.height,
                arrayBufferView : this._uint8View
            });
        }

        this._multipleDirtyPlanes = false;
        this._dirtyIndex = -1;
    };

    /**
     * Duplicates this ClippingPlaneCollection instance.
     *
     * @param {ClippingPlaneCollection} [result] The object onto which to store the result.
     * @returns {ClippingPlaneCollection} The modified result parameter or a new ClippingPlaneCollection instance if one was not provided.
     */
    ClippingPlaneCollection.prototype.clone = function(result) {
        if (!defined(result)) {
            result = new ClippingPlaneCollection();
        }

        var length = this.length;
        var i;
        if (result.length !== length) {
            var planes = result._planes;
            var index = planes.length;

            planes.length = length;
            for (i = index; i < length; ++i) {
                result._planes[i] = new ClippingPlane(Cartesian3.UNIT_X, 0.0);
            }
        }

        for (i = 0; i < length; ++i) {
            var resultPlane = result._planes[i];
            resultPlane.index = i;
            resultPlane.onChangeCallback = function(index) {
                setIndexDirty(result, index);
            };
            ClippingPlane.clone(this._planes[i], resultPlane);
        }

        result.enabled = this.enabled;
        Matrix4.clone(this.modelMatrix, result.modelMatrix);
        result.unionClippingRegions = this.unionClippingRegions;
        Color.clone(this.edgeColor, result.edgeColor);
        result.edgeWidth = this.edgeWidth;

        return result;
    };

    var scratchMatrix = new Matrix4();
    var scratchPlane = new Plane(Cartesian3.UNIT_X, 0.0);
    /**
     * Determines the type intersection with the planes of this ClippingPlaneCollection instance and the specified {@link TileBoundingVolume}.
     * @private
     *
     * @param {Object} tileBoundingVolume The volume to determine the intersection with the planes.
     * @param {Matrix4} [transform] An optional, additional matrix to transform the plane to world coordinates.
     * @returns {Intersect} {@link Intersect.INSIDE} if the entire volume is on the side of the planes
     *                      the normal is pointing and should be entirely rendered, {@link Intersect.OUTSIDE}
     *                      if the entire volume is on the opposite side and should be clipped, and
     *                      {@link Intersect.INTERSECTING} if the volume intersects the planes.
     */
    ClippingPlaneCollection.prototype.computeIntersectionWithBoundingVolume = function(tileBoundingVolume, transform) {
        var planes = this._planes;
        var length = planes.length;

        var modelMatrix = this.modelMatrix;
        if (defined(transform)) {
            modelMatrix = Matrix4.multiply(modelMatrix, transform, scratchMatrix);
        }

        // If the collection is not set to union the clipping regions, the volume must be outside of all planes to be
        // considered completely clipped. If the collection is set to union the clipping regions, if the volume can be
        // outside any the planes, it is considered completely clipped.
        // Lastly, if not completely clipped, if any plane is intersecting, more calculations must be performed.
        var intersection = Intersect.INSIDE;
        if (!this.unionClippingRegions && length > 0) {
            intersection = Intersect.OUTSIDE;
        }

        for (var i = 0; i < length; ++i) {
            var plane = planes[i];

            Plane.transform(plane, modelMatrix, scratchPlane); // ClippingPlane can be used for Plane math

            var value = tileBoundingVolume.intersectPlane(scratchPlane);
            if (value === Intersect.INTERSECTING) {
                intersection = value;
            } else if (this._testIntersection(value)) {
                return value;
            }
        }

        return intersection;
    };

    /**
     * Sets the owner for the input ClippingPlaneCollection if there wasn't another owner.
     * Destroys the owner's previous ClippingPlaneCollection if setting is successful.
     *
     * @param {ClippingPlaneCollection} [clippingPlaneCollection] A ClippingPlaneCollection (or undefined) being attached to an object
     * @param {Object} owner An Object that should receive the new ClippingPlaneCollection
     * @param {String} key The Key for the Object to reference the ClippingPlaneCollection
     * @private
     */
    ClippingPlaneCollection.setOwner = function(clippingPlaneCollection, owner, key) {
        // Don't destroy the ClippingPlaneCollection if it is already owned by newOwner
        if (clippingPlaneCollection === owner[key]) {
            return;
        }
        // Destroy the existing ClippingPlaneCollection, if any
        owner[key] = owner[key] && owner[key].destroy();
        if (defined(clippingPlaneCollection)) {
            //>>includeStart('debug', pragmas.debug);
            if (defined(clippingPlaneCollection._owner)) {
                throw new DeveloperError('ClippingPlaneCollection should only be assigned to one object');
            }
            //>>includeEnd('debug');
            clippingPlaneCollection._owner = owner;
            owner[key] = clippingPlaneCollection;
        }
    };

    /**
     * Determines if rendering with clipping planes is supported.
     *
     * @returns {Boolean} <code>true</code> if ClippingPlaneCollections are supported
     * @deprecated
     */
    ClippingPlaneCollection.isSupported = function() {
        deprecationWarning('ClippingPlaneCollection.isSupported', 'ClippingPlaneCollection.isSupported is deprecated and will be removed in Cesium 1.45. Clipping Planes are now supported on all platforms capable of running Cesium.');
        return true;
    };

    /**
     * Function for checking if the context will allow clipping planes with floating point textures.
     *
     * @param {Context} context The Context that will contain clipped objects and clipping textures.
     * @returns {Boolean} <code>true</code> if floating point textures can be used for clipping planes.
     * @private
     */
    ClippingPlaneCollection.useFloatTexture = function(context) {
        return context.floatingPointTexture;
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @returns {Boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
     *
     * @see ClippingPlaneCollection#destroy
     */
    ClippingPlaneCollection.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     *
     * @returns {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     *
     * @example
     * clippingPlanes = clippingPlanes && clippingPlanes .destroy();
     *
     * @see ClippingPlaneCollection#isDestroyed
     */
    ClippingPlaneCollection.prototype.destroy = function() {
        this._clippingPlanesTexture = this._clippingPlanesTexture && this._clippingPlanesTexture.destroy();
        return destroyObject(this);
    };

    return ClippingPlaneCollection;
});
