// Test script to verify skip functionality
// This will simulate the skip process and ensure terms change

async function testSkipFunctionality() {
    console.log('🧪 Testing Skip Functionality...');
    
    // Mock chrome storage and global environment
    globalThis.chrome = {
        storage: {
            local: {
                get: () => Promise.resolve({}),
                set: () => Promise.resolve()
            }
        },
        runtime: {
            getURL: (path) => path
        }
    };
    
    globalThis.fetch = require('node-fetch');
    
    // Load the GoogleTrend class
    const fs = require('fs');
    const path = require('path');
    
    const googleTrendCode = fs.readFileSync(path.join(__dirname, 'src/googleTrend.js'), 'utf8');
    
    // Create a proper execution context
    const vm = require('vm');
    const context = vm.createContext({
        chrome: globalThis.chrome,
        fetch: globalThis.fetch,
        console: console,
        setTimeout: setTimeout,
        Set: Set,
        Math: Math,
        Date: Date,
        Promise: Promise
    });
    
    // Execute the GoogleTrend class definition
    vm.runInContext(googleTrendCode, context);
    
    // Create instance
    const googleTrend = new context.GoogleTrend();
    
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('📋 Getting initial terms...');
    const term1PC = await googleTrend.getNextTermForDisplay('PC');
    const term1Mobile = await googleTrend.getNextTermForDisplay('mobile');
    
    console.log('Initial PC term:', term1PC);
    console.log('Initial Mobile term:', term1Mobile);
    
    console.log('\n🔄 Performing skip...');
    await googleTrend.skipCurrentTerm();
    
    console.log('📋 Getting terms after skip...');
    const term2PC = await googleTrend.getNextTermForDisplay('PC');
    const term2Mobile = await googleTrend.getNextTermForDisplay('mobile');
    
    console.log('After skip PC term:', term2PC);
    console.log('After skip Mobile term:', term2Mobile);
    
    // Verify terms changed
    const pcChanged = term1PC !== term2PC;
    const mobileChanged = term1Mobile !== term2Mobile;
    
    console.log('\n✅ Test Results:');
    console.log('PC term changed:', pcChanged ? '✅ YES' : '❌ NO');
    console.log('Mobile term changed:', mobileChanged ? '✅ YES' : '❌ NO');
    
    if (pcChanged && mobileChanged) {
        console.log('\n🎉 Skip functionality is working correctly!');
    } else {
        console.log('\n❌ Skip functionality needs attention');
    }
}

// Run the test
testSkipFunctionality().catch(console.error);
