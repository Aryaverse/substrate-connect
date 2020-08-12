// Copyright 2018-2020 @paritytech/substrate-light-ui authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

export * from './types';
export * from './WasmProvider';

/**
 * Hosts
 */

/* tslint:disable */
// import * as wasm from './client-packages/polkadot/polkadot_cli_bg';
// export { wasm };

/**
 * Light clients
 */
export * from './client-specs/kusama';
export * from './client-specs/polkadot';
export * from './client-specs/polkadot-local';
export * from './client-specs/westend';
