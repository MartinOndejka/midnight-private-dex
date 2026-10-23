// This file is part of midnightntwrk/example-bboard.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import React, { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { MainLayout, Dex } from './components';
import { useDeployedDexContext } from './hooks';
import { type DexDeployment } from './contexts';
import { type Observable } from 'rxjs';

/**
 * The root DEX application component.
 *
 * @remarks
 * The {@link App} component requires a `<DeployedDexProvider />` parent in order to retrieve
 * information about current DEX deployments.
 *
 * @internal
 */
const App: React.FC = () => {
  const dexApiProvider = useDeployedDexContext();
  const [dexDeployments, setDexDeployments] = useState<Array<Observable<DexDeployment>>>([]);

  useEffect(() => {
    const subscription = dexApiProvider.dexDeployments$.subscribe(setDexDeployments);

    return () => {
      subscription.unsubscribe();
    };
  }, [dexApiProvider]);

  return (
    <Box sx={{ background: '#000', minHeight: '100vh' }}>
      <MainLayout>
        {dexDeployments.map((dexDeployment, idx) => (
          <div data-testid={`dex-${idx}`} key={`dex-${idx}`}>
            <Dex dexDeployment$={dexDeployment} />
          </div>
        ))}
        <div data-testid="dex-start">
          <Dex />
        </div>
      </MainLayout>
    </Box>
  );
};

export default App;
